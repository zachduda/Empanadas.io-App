'use strict';

// This computer's key for end-to-end encrypted messages, one per account
// (lib/dme2ee.js). The private half never leaves this file; the operating
// system's keychain locks it (Electron's safeStorage) wherever it can.

const jsonfile = require('./jsonfile');

function createKeyStore(file, safeStorage = null) {
	const locked = () => !!(safeStorage && safeStorage.isEncryptionAvailable && safeStorage.isEncryptionAvailable());

	return {
		load(account) {
			const all = jsonfile.read(file, {}) || {};
			const entry = all[String(account)];
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
		},
		save(account, value) {
			const all = jsonfile.read(file, {}) || {};
			const text = JSON.stringify(value);
			all[String(account)] = locked()
				? { sealed: safeStorage.encryptString(text).toString('base64') }
				: { plain: text };
			return jsonfile.write(file, all);
		}
	};
}

module.exports = { createKeyStore };
