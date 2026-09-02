'use strict';

// Exercises lib/pgp.js against real GnuPG output (see fixtures/README.md).
//
// This is the one part of the updater with actual cryptography in it, and the
// one part where a bug is silent: a verifier that accepts everything looks
// exactly like a verifier that works, right up until someone hands the app a
// forged installer. So the negative cases matter more than the positive one,
// and each is a different way of being wrong.

const fs = require('fs');
const path = require('path');
const pgp = require('../lib/pgp');

const FIXTURES = path.join(__dirname, 'fixtures');
const read = (name) => fs.readFileSync(path.join(FIXTURES, name));

// The throwaway key the fixtures were signed with.
const SIGNER = '547EF74C96557FF8E58818051A79AE419A604672';

const results = [];

function test(what, fn) {
	try {
		fn();
		results.push(null);
		console.log('  ok    ' + what);
	} catch (err) {
		results.push(what + ': ' + err.message);
		console.log('  FAIL  ' + what + ' - ' + err.message);
	}
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

// Asserts that a verification fails, and fails *for the stated reason* - a test
// that only checks "it threw" passes just as happily when the code throws on
// its own inputs.
function rejects(fn, because) {
	let threw = null;
	try {
		fn();
	} catch (err) {
		threw = err;
	}
	assert(threw, 'expected a rejection, but it verified');
	assert(threw.message.includes(because),
		'rejected for the wrong reason: ' + threw.message);
}

const payload = read('payload.bin');
const keys = pgp.parsePublicKeys(read('signer.pub.asc'));

// --- key parsing ------------------------------------------------------

test('reads an armored public key export', () => {
	assert(keys.length === 1, 'expected one key, got ' + keys.length);
	assert(keys[0].fingerprint === SIGNER, 'fingerprint is ' + keys[0].fingerprint);
	assert(keys[0].keyId === SIGNER.slice(-16), 'key id is ' + keys[0].keyId);
});

test('reads a binary public key export identically', () => {
	// The two exports use different packet header formats, so this is a real
	// difference in the parsing path, not the same test twice.
	const binary = pgp.parsePublicKeys(read('signer.pub.gpg'));
	assert(JSON.stringify(binary) === JSON.stringify(keys),
		'binary and armored exports disagree');
});

test('converts the RSA key to a PEM node will load', () => {
	assert(/^-----BEGIN PUBLIC KEY-----\n/.test(keys[0].pem), 'not a SPKI PEM');
	require('crypto').createPublicKey(keys[0].pem);
});

// --- signatures that should verify ------------------------------------

test('verifies a binary SHA-256 detached signature', () => {
	const result = pgp.verifyDetached(payload, read('payload.sig'), keys);
	assert(result.key.fingerprint === SIGNER, 'attributed to the wrong key');
	assert(result.hash === 'sha256', 'hash reported as ' + result.hash);
});

test('verifies an armored SHA-512 detached signature', () => {
	const result = pgp.verifyDetached(payload, read('payload-sha512.asc'), keys);
	assert(result.hash === 'sha512', 'hash reported as ' + result.hash);
});

test('verifies the same signature streaming from a file', () => {
	// The updater uses this path, not the Buffer one - the installer is too
	// large to hold in memory just to hash it.
	const result = pgp.verifyDetachedFile(
		path.join(FIXTURES, 'payload.bin'), read('payload.sig'), keys);
	assert(result.key.fingerprint === SIGNER, 'attributed to the wrong key');
});

test('streaming verification is correct across chunk boundaries', () => {
	// A real installer is far bigger than the 1 MB read buffer, so the chunk
	// loop matters, but the fixture is 64 bytes and would never exercise it.
	// Shrinking the buffer instead reaches the same code with a real signature:
	// at 7 bytes the 64-byte payload takes ten reads and a short final one, and
	// any off-by-one or buffer-reuse bug breaks the digest.
	for (const chunkSize of [1, 7, 63, 64, 65]) {
		const result = pgp.verifyDetachedFile(
			path.join(FIXTURES, 'payload.bin'), read('payload.sig'), keys, chunkSize);
		assert(result.key.fingerprint === SIGNER, 'failed at chunk size ' + chunkSize);
	}
});

// --- signatures that must not verify ----------------------------------

test('rejects a single flipped bit in the payload', () => {
	const tampered = Buffer.from(payload);
	tampered[10] ^= 0x01;
	rejects(() => pgp.verifyDetached(tampered, read('payload.sig'), keys),
		'does not verify');
});

test('rejects a truncated payload', () => {
	rejects(() => pgp.verifyDetached(payload.slice(0, -1), read('payload.sig'), keys),
		'does not verify');
});

test('rejects a payload with bytes appended', () => {
	rejects(() => pgp.verifyDetached(Buffer.concat([payload, Buffer.from('x')]),
		read('payload.sig'), keys), 'does not verify');
});

test('rejects a valid signature made by a key we do not pin', () => {
	// The interesting case: the signature is genuine and would verify against
	// its own key. Only the pin stops it.
	rejects(() => pgp.verifyDetached(payload, read('payload-wrong-key.sig'), keys),
		'not a pinned release key');
});

test('rejects everything when no keys are pinned', () => {
	// Fail closed: an empty or missing release-keys.json must not mean "allow".
	rejects(() => pgp.verifyDetached(payload, read('payload.sig'), []),
		'not a pinned release key');
});

test('rejects a corrupted signature body', () => {
	const flipped = Buffer.from(read('payload.sig'));
	flipped[flipped.length - 5] ^= 0x01;
	rejects(() => pgp.verifyDetached(payload, flipped, keys), 'does not verify');
});

test('rejects a signature whose issuer subpacket has been repointed', () => {
	// Swapping the issuer fingerprint to one we do pin must not help: the
	// fingerprint lives in the hashed region, so changing it breaks the hash.
	const sig = Buffer.from(read('payload.sig'));
	const at = sig.indexOf(Buffer.from(SIGNER, 'hex'));
	assert(at > 0, 'fixture no longer contains the issuer fingerprint');
	sig[at + 19] ^= 0x01;
	const forged = keys.map((k) => Object.assign({}, k, {
		fingerprint: SIGNER.slice(0, 38) + (parseInt(SIGNER.slice(38), 16) ^ 1).toString(16).padStart(2, '0').toUpperCase()
	}));
	rejects(() => pgp.verifyDetached(payload, sig, forged), 'does not verify');
});

test('rejects input that is not a signature at all', () => {
	rejects(() => pgp.verifyDetached(payload, Buffer.from('hello world'), keys), 'OpenPGP');
});

test('rejects an empty signature', () => {
	rejects(() => pgp.verifyDetached(payload, Buffer.alloc(0), keys),
		'no signature packet');
});

// --- the real release key ---------------------------------------------

test('parses the signature shipped with the 1.10.8 release', () => {
	// Not a verification - the app pins the key, and this only confirms the
	// parser handles the exact shape gpg produces for real releases.
	const file = path.join(__dirname, '..', 'dist', 'empanadas.io-Setup-1.10.8.exe.sig');
	if (!fs.existsSync(file)) return;
	const sig = pgp.parseSignature(fs.readFileSync(file));
	assert(sig.hashName === 'sha256', 'hash is ' + sig.hashName);
	assert(sig.sigType === 0, 'signature type is 0x' + sig.sigType.toString(16));
	assert(/^[0-9A-F]{40}$/.test(sig.issuerFingerprint || ''),
		'no issuer fingerprint: ' + sig.issuerFingerprint);
});

module.exports = { failures: results.filter(Boolean) };

if (require.main === module) {
	const failed = results.filter(Boolean);
	if (failed.length) {
		console.error('\n' + failed.length + ' failed');
		process.exit(1);
	}
	console.log('\nAll signature tests passed.');
}
