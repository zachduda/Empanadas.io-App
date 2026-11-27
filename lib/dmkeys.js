'use strict';

// This computer's key for end-to-end encrypted messages, one per account
// (lib/dme2ee.js). The private half never leaves this file; the operating
// system's keychain locks it (Electron's safeStorage) wherever it can.
//
// A key that is there but can't be unlocked right now (the keychain said no,
// or isn't available this launch) is never written over: it is kept as
// retired, a new one is made for what is sent from now on, and the retired
// ones are tried on what the new one can't open, so nothing sealed for the
// old key is lost once the keychain answers again.

const jsonfile = require('./jsonfile');

// Keys kept beside the current one per account.
const MAX_RETIRED = 5;

function createKeyStore(file, safeStorage = null) {
	const locked = () => !!(safeStorage && safeStorage.isEncryptionAvailable && safeStorage.isEncryptionAvailable());

	function seal(value) {
		const text = JSON.stringify(value);
		return locked() ? { sealed: safeStorage.encryptString(text).toString('base64') } : { plain: text };
	}

	// A stored key, or null when it can't be read now.
	function unseal(entry) {
		if (!entry) return null;
		try {
			const text = entry.sealed
				? (locked() ? safeStorage.decryptString(Buffer.from(entry.sealed, 'base64')) : null)
				: entry.plain;
			const value = text ? JSON.parse(text) : null;
			return value && value.jwk && value.publicKey && value.device ? value : null;
		} catch (err) {
			return null;
		}
	}

	function account(all, id) {
		const entry = all[String(id)];
		return entry && typeof entry === 'object' ? entry : null;
	}

	return {
		// { status: 'ok', key } | { status: 'missing' } | { status: 'locked' }: there is one, and
		// it can't be read now.
		read(id) {
			const entry = account(jsonfile.read(file, {}) || {}, id);
			if (!entry || (!entry.sealed && !entry.plain)) return { status: 'missing' };
			const key = unseal(entry);
			return key ? { status: 'ok', key } : { status: 'locked' };
		},
		load(id) {
			const found = this.read(id);
			return found.status === 'ok' ? found.key : null;
		},
		// The account's new key. One it had that can't be read now is kept as retired, never lost.
		save(id, value) {
			const all = jsonfile.read(file, {}) || {};
			const was = account(all, id);
			const retired = was && Array.isArray(was.retired) ? was.retired.slice() : [];
			if (was && (was.sealed || was.plain)) {
				const old = unseal(was);
				if (!old || old.device !== value.device) retired.unshift(was.sealed ? { sealed: was.sealed } : { plain: was.plain });
			}
			all[String(id)] = Object.assign(seal(value), retired.length ? { retired: retired.slice(0, MAX_RETIRED) } : {});
			return jsonfile.write(file, all);
		},
		// The account's earlier keys that can be read now, for what the current one can't open.
		retired(id) {
			const entry = account(jsonfile.read(file, {}) || {}, id);
			return entry && Array.isArray(entry.retired) ? entry.retired.map(unseal).filter(Boolean) : [];
		}
	};
}

module.exports = { createKeyStore };
