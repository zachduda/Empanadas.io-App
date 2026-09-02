'use strict';

// A small OpenPGP reader: enough to check a detached signature over a release
// asset, and nothing more.
//
// Why not the `openpgp` package: this app ships with zero runtime dependencies
// on purpose, and the updater is the last place to start pulling code off npm -
// a dependency here is a dependency inside the trust check itself. What is
// actually needed is narrow. An OpenPGP RSA signature is PKCS#1 v1.5 over a
// hash of (file || the signature's own hashed fields || a trailer), so once the
// packet is parsed, node's crypto does the cryptography.
//
// Deliberately not supported: encrypted messages, key expiry and revocation,
// web-of-trust, certification signatures. The key is pinned by fingerprint in
// the app, so "is this key trusted" is answered by the pin, not by a keyring.
//
// References: RFC 4880 sections 4.2 (packet headers), 5.2 (signature packets),
// 5.5.2 (public-key packets) and 12.2 (fingerprints).

const crypto = require('crypto');
const fs = require('fs');

const PUBKEY_ALGO = { RSA_ENCRYPT_SIGN: 1, RSA_SIGN: 3 };

const HASH_ALGO = {
	2: 'sha1',
	8: 'sha256',
	9: 'sha384',
	10: 'sha512'
};

// Only signatures over a binary document count. 0x01 is the same signature over
// text with line endings canonicalised, which is not how an installer is
// signed; the rest are certifications and key bindings.
const SIG_TYPE_BINARY = 0x00;

function fail(message) {
	throw new Error('OpenPGP: ' + message);
}

// --- armor ------------------------------------------------------------

function isArmored(buf) {
	return buf.slice(0, 5).toString('latin1') === '-----';
}

// Strips the ASCII-armor wrapper from a .asc file and returns the packet bytes.
function dearmor(buf) {
	const text = buf.toString('utf8');
	const body = /-----BEGIN PGP [^-]+-----\r?\n([\s\S]*?)\r?\n-----END PGP/.exec(text);
	if (!body) fail('input looks armored but has no PGP block');

	const lines = body[1].split(/\r?\n/);
	const out = [];
	let seenBlank = false;

	for (const line of lines) {
		// Armor headers ("Version: ...") run until the first blank line.
		if (!seenBlank) {
			if (line.trim() === '') { seenBlank = true; continue; }
			if (/^[A-Za-z][A-Za-z-]*:\s/.test(line)) continue;
			seenBlank = true;
		}
		// The line starting with '=' is the CRC24 checksum, not data. The armor
		// is a transport encoding, so a corrupt one shows up as a bad signature
		// anyway; there is nothing to gain by checking it separately.
		if (line.startsWith('=')) break;
		out.push(line.trim());
	}

	return Buffer.from(out.join(''), 'base64');
}

function toPackets(buf) {
	return isArmored(buf) ? dearmor(buf) : buf;
}

// --- packets ----------------------------------------------------------

// Walks the packet stream and yields {tag, body}. Handles both the old and the
// new header format; gpg emits old-format headers for detached signatures and
// new-format for exported keys, so both turn up in practice.
function readPackets(buf) {
	const packets = [];
	let i = 0;

	while (i < buf.length) {
		const header = buf[i++];
		if (!(header & 0x80)) fail('not an OpenPGP packet stream');

		let tag;
		let length;

		if (header & 0x40) {
			// New format: tag in the low 6 bits, then a variable-length length.
			tag = header & 0x3f;
			const first = buf[i++];
			if (first < 192) {
				length = first;
			} else if (first < 224) {
				length = ((first - 192) << 8) + buf[i++] + 192;
			} else if (first === 255) {
				length = buf.readUInt32BE(i);
				i += 4;
			} else {
				// Partial body lengths only occur in streamed literal data.
				fail('partial packet lengths are not supported');
			}
		} else {
			// Old format: tag in bits 5-2, length type in the low 2 bits.
			tag = (header & 0x3c) >> 2;
			const lengthType = header & 0x03;
			if (lengthType === 0) { length = buf[i]; i += 1; }
			else if (lengthType === 1) { length = buf.readUInt16BE(i); i += 2; }
			else if (lengthType === 2) { length = buf.readUInt32BE(i); i += 4; }
			else fail('indeterminate packet lengths are not supported');
		}

		if (i + length > buf.length) fail('packet runs past the end of the input');
		packets.push({ tag, body: buf.slice(i, i + length) });
		i += length;
	}

	return packets;
}

// Multiprecision integer: a 2-byte bit count followed by that many bits.
function readMpi(buf, offset) {
	const bits = buf.readUInt16BE(offset);
	const bytes = Math.ceil(bits / 8);
	const start = offset + 2;
	if (start + bytes > buf.length) fail('truncated MPI');
	return { value: buf.slice(start, start + bytes), next: start + bytes };
}

// Subpackets are used here only to find which key made the signature.
function readSubpackets(buf) {
	const found = {};
	let i = 0;

	while (i < buf.length) {
		let length;
		const first = buf[i++];
		if (first < 192) {
			length = first;
		} else if (first < 255) {
			length = ((first - 192) << 8) + buf[i++] + 192;
		} else {
			length = buf.readUInt32BE(i);
			i += 4;
		}
		if (length < 1 || i + length > buf.length) fail('truncated subpacket');

		const type = buf[i] & 0x7f;
		const data = buf.slice(i + 1, i + length);
		i += length;

		// 33 = issuer fingerprint (v4 keys: a version byte then 20 bytes).
		if (type === 33 && data.length === 21 && data[0] === 4) {
			found.issuerFingerprint = data.slice(1).toString('hex').toUpperCase();
		}
		// 16 = issuer key ID, the low 8 bytes of the fingerprint. Older gpg
		// puts only this in, so it is the fallback.
		if (type === 16 && data.length === 8) {
			found.issuerKeyId = data.toString('hex').toUpperCase();
		}
	}

	return found;
}

// --- signatures -------------------------------------------------------

function parseSignature(input) {
	const packets = readPackets(toPackets(input));
	const packet = packets.find((p) => p.tag === 2);
	if (!packet) fail('no signature packet found');

	const body = packet.body;
	if (body[0] !== 4) fail('unsupported signature version ' + body[0] + ' (only v4)');

	const sigType = body[1];
	const pubKeyAlgo = body[2];
	const hashAlgo = body[3];
	const hashedLength = body.readUInt16BE(4);

	// Everything the signer committed to: the fixed fields plus the hashed
	// subpackets. This exact run of bytes is fed to the hash after the file.
	const hashedEnd = 6 + hashedLength;
	if (hashedEnd > body.length) fail('hashed subpacket region runs past the packet');
	const hashedRegion = body.slice(0, hashedEnd);

	const unhashedLength = body.readUInt16BE(hashedEnd);
	const unhashedEnd = hashedEnd + 2 + unhashedLength;
	if (unhashedEnd + 2 > body.length) fail('unhashed subpacket region runs past the packet');

	const issuer = Object.assign(
		{},
		readSubpackets(body.slice(hashedEnd + 2, unhashedEnd)),
		// Hashed subpackets are covered by the signature, so they win.
		readSubpackets(body.slice(6, hashedEnd))
	);

	// Two bytes of the digest, stored so a wrong key can be rejected cheaply.
	// Not a security check - the real one is the RSA verify.
	const quickCheck = body.slice(unhashedEnd, unhashedEnd + 2);
	const mpi = readMpi(body, unhashedEnd + 2);

	return {
		sigType,
		pubKeyAlgo,
		hashAlgo,
		hashName: HASH_ALGO[hashAlgo],
		hashedRegion,
		quickCheck,
		signature: mpi.value,
		issuerFingerprint: issuer.issuerFingerprint || null,
		issuerKeyId: issuer.issuerKeyId ||
			(issuer.issuerFingerprint ? issuer.issuerFingerprint.slice(-16) : null)
	};
}

// RFC 4880 5.2.4: the signature covers the data, then its own hashed region,
// then a six-byte trailer giving that region's length.
function trailerFor(hashedRegion) {
	const trailer = Buffer.alloc(6);
	trailer[0] = 0x04;
	trailer[1] = 0xff;
	trailer.writeUInt32BE(hashedRegion.length, 2);
	return trailer;
}

// --- public keys ------------------------------------------------------

// v4 fingerprint: SHA-1 over 0x99, the two-byte packet length, and the packet.
function keyFingerprint(body) {
	const prefix = Buffer.alloc(3);
	prefix[0] = 0x99;
	prefix.writeUInt16BE(body.length, 1);
	return crypto.createHash('sha1').update(prefix).update(body).digest('hex').toUpperCase();
}

// Wraps a raw RSA modulus and exponent as a SubjectPublicKeyInfo, which is what
// node's crypto can actually load. Written out by hand rather than pulling in
// an ASN.1 library - the structure is fixed and short.
function der(tag, payload) {
	let length;
	if (payload.length < 0x80) {
		length = Buffer.from([payload.length]);
	} else {
		const bytes = [];
		let n = payload.length;
		while (n > 0) { bytes.unshift(n & 0xff); n >>= 8; }
		length = Buffer.from([0x80 | bytes.length].concat(bytes));
	}
	return Buffer.concat([Buffer.from([tag]), length, payload]);
}

function derInteger(bytes) {
	let i = 0;
	while (i < bytes.length - 1 && bytes[i] === 0) i++;
	let value = bytes.slice(i);
	// DER integers are signed, so a leading bit of 1 needs a zero byte in front.
	if (value[0] & 0x80) value = Buffer.concat([Buffer.from([0]), value]);
	return der(0x02, value);
}

const RSA_OID = Buffer.from('300d06092a864886f70d0101010500', 'hex');

function rsaToSpkiPem(modulus, exponent) {
	const rsaKey = der(0x30, Buffer.concat([derInteger(modulus), derInteger(exponent)]));
	const bitString = der(0x03, Buffer.concat([Buffer.from([0]), rsaKey]));
	const spki = der(0x30, Buffer.concat([RSA_OID, bitString]));
	const b64 = spki.toString('base64').replace(/(.{64})/g, '$1\n');
	return '-----BEGIN PUBLIC KEY-----\n' + b64 + '\n-----END PUBLIC KEY-----\n';
}

// Reads an exported public key (armored or binary) and returns every RSA key in
// it - the primary and any subkeys - as {fingerprint, keyId, pem}. Which one
// signed a given release is decided by the signature's issuer, so all of them
// are kept.
function parsePublicKeys(input) {
	const packets = readPackets(toPackets(input));
	const keys = [];

	for (const packet of packets) {
		// 6 = public key, 14 = public subkey.
		if (packet.tag !== 6 && packet.tag !== 14) continue;

		const body = packet.body;
		if (body[0] !== 4) continue;

		const algo = body[5];
		if (algo !== PUBKEY_ALGO.RSA_ENCRYPT_SIGN && algo !== PUBKEY_ALGO.RSA_SIGN) continue;

		const modulus = readMpi(body, 6);
		const exponent = readMpi(body, modulus.next);
		const fingerprint = keyFingerprint(body);

		keys.push({
			fingerprint,
			keyId: fingerprint.slice(-16),
			primary: packet.tag === 6,
			pem: rsaToSpkiPem(modulus.value, exponent.value)
		});
	}

	if (!keys.length) fail('no RSA public key found in the input');
	return keys;
}

// --- verification -----------------------------------------------------

/**
 * Checks a detached signature over `data`.
 *
 * `data` is either a Buffer or a function that feeds the content into a hash,
 * called as feed(verifier) - see verifyDetachedFile, which uses that to avoid
 * holding a 100 MB installer in memory.
 *
 * `keys` is a list of {fingerprint, pem} as produced by parsePublicKeys and
 * stored in release-keys.json. Returns the key that signed it; throws with a
 * specific reason if nothing does. There is no "unknown" middle state: the
 * caller gets a key or an error.
 */
function verifyDetached(data, signatureInput, keys) {
	const sig = parseSignature(signatureInput);

	if (sig.sigType !== SIG_TYPE_BINARY) {
		fail('signature is type 0x' + sig.sigType.toString(16) +
			', expected 0x00 (binary document)');
	}
	if (sig.pubKeyAlgo !== PUBKEY_ALGO.RSA_ENCRYPT_SIGN && sig.pubKeyAlgo !== PUBKEY_ALGO.RSA_SIGN) {
		fail('public key algorithm ' + sig.pubKeyAlgo + ' is not supported (RSA only)');
	}
	if (!sig.hashName) {
		fail('hash algorithm ' + sig.hashAlgo + ' is not supported');
	}
	if (sig.hashAlgo === 2) {
		fail('signature uses SHA-1, which is not accepted');
	}

	// Match on the full fingerprint when the signature carries one, and fall
	// back to the 8-byte key ID only for signatures old enough to lack it.
	const candidates = keys.filter((key) => {
		if (sig.issuerFingerprint) return key.fingerprint === sig.issuerFingerprint;
		return sig.issuerKeyId && key.keyId === sig.issuerKeyId;
	});

	if (!candidates.length) {
		fail('signed by ' + (sig.issuerFingerprint || sig.issuerKeyId || 'an unnamed key') +
			', which is not a pinned release key');
	}

	const feed = typeof data === 'function' ? data : (verifier) => verifier.update(data);

	for (const key of candidates) {
		const verifier = crypto.createVerify(sig.hashName);
		feed(verifier);
		verifier.update(sig.hashedRegion);
		verifier.update(trailerFor(sig.hashedRegion));
		if (verifier.verify(key.pem, sig.signature)) {
			return { key, hash: sig.hashName };
		}
	}

	fail('signature does not verify against the pinned key');
}

// Same check against a file on disk, read in chunks. The installer is well over
// 100 MB and this runs on the main process, so buffering the whole thing to
// verify it would be a visible stall and a large allocation for no reason.
function verifyDetachedFile(filePath, signatureInput, keys, chunkSize = 1024 * 1024) {
	const feed = (verifier) => {
		const fd = fs.openSync(filePath, 'r');
		try {
			const buffer = Buffer.alloc(chunkSize);
			let read;
			while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
				verifier.update(read === buffer.length ? buffer : buffer.slice(0, read));
			}
		} finally {
			fs.closeSync(fd);
		}
	};
	return verifyDetached(feed, signatureInput, keys);
}

module.exports = {
	parseSignature,
	parsePublicKeys,
	verifyDetached,
	verifyDetachedFile,
	rsaToSpkiPem,
	// exported for testing
	dearmor,
	readPackets
};
