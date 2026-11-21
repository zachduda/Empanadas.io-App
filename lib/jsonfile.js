'use strict';

// Small JSON files in the app's data folder, written aside and renamed so a
// crash mid-write cannot leave half a file behind. Everything that reads one
// copes with it being missing or unreadable.

const fs = require('fs');
const path = require('path');

function read(file, fallback = null) {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch (err) {
		return fallback;
	}
}

function write(file, value) {
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const temp = file + '.' + process.pid + '.tmp';
		fs.writeFileSync(temp, JSON.stringify(value));
		fs.renameSync(temp, file);
		return true;
	} catch (err) {
		return false;
	}
}

function remove(file) {
	try {
		fs.rmSync(file, { force: true });
	} catch (err) {
		// Already gone.
	}
}

// One small object kept in a file: get() a copy, set(patch) merges and saves.
function createStore(file, defaults = {}) {
	let state = Object.assign({}, defaults, read(file, {}) || {});
	return {
		get: () => Object.assign({}, state),
		set(patch) {
			state = Object.assign({}, state, patch);
			write(file, state);
			return Object.assign({}, state);
		},
		reset() {
			state = Object.assign({}, defaults);
			remove(file);
		}
	};
}

module.exports = { read, write, remove, createStore };
