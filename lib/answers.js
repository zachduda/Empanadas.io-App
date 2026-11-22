'use strict';

// The last good answer of each native screen's endpoint, kept on disk so the
// app opens with it at launch and keeps showing it without a connection,
// saying when it was saved. The same idea as the iOS app's OfflineStore.
//
// Only the signed-in player's own data, and only for the screens that are
// worth opening offline. Cleared at sign-out. A request that was already on
// its way when the player signed out must not write the old account back, so
// each save names the generation it started in, and a save from an older one
// is dropped.

const path = require('path');
const jsonfile = require('./jsonfile');

const KEYS = Object.freeze(['account', 'dashboard', 'leaderboard', 'profile', 'updates']);

// A csrf token belongs to the session it was handed out in: never to disk.
function withoutToken(body) {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
	if (!('csrf' in body)) return body;
	return Object.assign({}, body, { csrf: '' });
}

function createAnswers(dir, { now = () => Date.now() } = {}) {
	let generation = 0;
	const memory = new Map();

	const fileOf = (key) => path.join(dir, key + '.json');

	function known(key) {
		return KEYS.includes(key);
	}

	return {
		get generation() { return generation; },

		save(key, body, startedIn = generation) {
			if (!known(key) || startedIn !== generation) return false;
			const entry = { savedAt: now(), body: withoutToken(body) };
			memory.set(key, entry);
			jsonfile.write(fileOf(key), entry);
			return true;
		},

		// { savedAt, body } or null.
		load(key) {
			if (!known(key)) return null;
			if (memory.has(key)) return memory.get(key);
			const entry = jsonfile.read(fileOf(key));
			if (!entry || typeof entry.savedAt !== 'number' || !entry.body) return null;
			memory.set(key, entry);
			return entry;
		},

		clear() {
			generation++;
			memory.clear();
			for (const key of KEYS) jsonfile.remove(fileOf(key));
		}
	};
}

module.exports = { KEYS, withoutToken, createAnswers };
