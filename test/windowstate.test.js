'use strict';

// lib/windowstate.js decides how big the main window is and where it opens.
// A mistake here is a window with its buttons off the edge of the screen, or
// one that opens on a monitor that is no longer there.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { load, save, place } = require('../lib/windowstate');

const failures = [];

function check(what, fn) {
	try {
		fn();
		console.log('  ok    ' + what);
	} catch (err) {
		failures.push(what + ': ' + err.message);
		console.log('  FAIL  ' + what + ' - ' + err.message);
	}
}

const DEFAULTS = { width: 1100, height: 700, minWidth: 975, minHeight: 480 };
const DESKTOP = { x: 0, y: 0, width: 1920, height: 1040 };
// 1366x768 at 150% scaling, less the taskbar.
const SMALL = { x: 0, y: 0, width: 911, height: 472 };

check('opens at the default size, centred, with nothing saved', () => {
	const out = place(null, [DESKTOP], DESKTOP, DEFAULTS);
	assert.strictEqual(out.width, 1100);
	assert.strictEqual(out.height, 700);
	assert.strictEqual(out.minWidth, 975);
	assert.strictEqual(out.x, undefined);
	assert.strictEqual(out.maximized, false);
});

check('never asks for more than the display has, minimum size included', () => {
	const out = place(null, [SMALL], SMALL, DEFAULTS);
	assert(out.width <= SMALL.width && out.height <= SMALL.height, 'the window is larger than the display');
	assert(out.minWidth <= SMALL.width && out.minHeight <= SMALL.height, 'the minimum is larger than the display');
	assert(out.minWidth <= out.width && out.minHeight <= out.height, 'the minimum is larger than the window');
});

check('goes back to where it was', () => {
	const saved = { x: 300, y: 120, width: 1200, height: 800, maximized: true };
	const out = place(saved, [DESKTOP], DESKTOP, DEFAULTS);
	assert.deepStrictEqual([out.x, out.y, out.width, out.height], [300, 120, 1200, 800]);
	assert.strictEqual(out.maximized, true);
});

check('uses the display the window was on', () => {
	const second = { x: 1920, y: 0, width: 1280, height: 984 };
	const saved = { x: 2000, y: 50, width: 1100, height: 700, maximized: false };
	const out = place(saved, [DESKTOP, second], DESKTOP, DEFAULTS);
	assert.strictEqual(out.x, 2000);
});

check('forgets a place on a display that has gone', () => {
	const saved = { x: 2400, y: 50, width: 1100, height: 700, maximized: false };
	const out = place(saved, [DESKTOP], DESKTOP, DEFAULTS);
	assert.strictEqual(out.x, undefined, 'kept a position off every display');
	assert.strictEqual(out.width, 1100);
});

check('pulls a window that hangs off the edge back on', () => {
	const saved = { x: 1000, y: 400, width: 1100, height: 700, maximized: false };
	const out = place(saved, [DESKTOP], DESKTOP, DEFAULTS);
	assert(out.x + out.width <= DESKTOP.width && out.y + out.height <= DESKTOP.height, 'still off the edge');
});

check('shrinks a saved size to a smaller display', () => {
	const saved = { x: 0, y: 0, width: 1600, height: 900, maximized: false };
	const out = place(saved, [SMALL], SMALL, DEFAULTS);
	assert(out.width <= SMALL.width && out.height <= SMALL.height);
});

check('saves and loads, and reads rubbish as nothing', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'windowstate-'));
	const file = path.join(dir, 'window-state.json');
	try {
		assert.strictEqual(load(file), null, 'a missing file');
		save(file, { x: 10.4, y: 20, width: 1000, height: 600, maximized: true });
		assert.deepStrictEqual(load(file), { x: 10, y: 20, width: 1000, height: 600, maximized: true });
		fs.writeFileSync(file, '{"x":"left"}');
		assert.strictEqual(load(file), null, 'a file without numbers');
		fs.writeFileSync(file, 'not json');
		assert.strictEqual(load(file), null, 'a file that is not JSON');
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

module.exports = { failures };

if (require.main === module) {
	if (failures.length) {
		console.error(failures.length + ' check(s) failed');
		process.exit(1);
	}
}
