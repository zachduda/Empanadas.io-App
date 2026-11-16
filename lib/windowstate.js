'use strict';

// Where the main window was, kept between launches, and how big it may be on
// the displays there are now. Plain Node, so it can be tested without
// Electron: main.js hands in the displays' work areas ({x, y, width, height}).

const fs = require('fs');
const path = require('path');

function load(file) {
	try {
		const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
		const numbers = ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(saved[key]));
		if (!numbers) return null;
		return {
			x: Math.round(saved.x),
			y: Math.round(saved.y),
			width: Math.round(saved.width),
			height: Math.round(saved.height),
			maximized: saved.maximized === true
		};
	} catch (err) {
		return null;
	}
}

function save(file, state) {
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const temp = file + '.tmp';
		fs.writeFileSync(temp, JSON.stringify({
			x: state.x, y: state.y, width: state.width, height: state.height,
			maximized: state.maximized === true
		}));
		fs.renameSync(temp, file);
	} catch (err) {
		// Only where the window opens next time.
	}
}

// How much of a window lies on a display.
function overlap(a, b) {
	const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
	const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
	return w > 0 && h > 0 ? w * h : 0;
}

// The window's size, minimum size and position: { width, height, minWidth,
// minHeight, x, y, maximized }. x and y are undefined when there is nothing
// saved worth going back to, which centres the window.
//
//  - `saved` is load()'s, or null; `displays` every display's work area;
//    `primary` the main one's; `defaults` { width, height, minWidth, minHeight }.
//  - Nothing is ever larger than the display it opens on: a minimum wider
//    than the screen put the window's edge, and the page's buttons, off it.
//  - A saved place is only used while most of it is still on a display (a
//    monitor since unplugged would leave the window out of reach).
function place(saved, displays, primary, defaults) {
	const areas = Array.isArray(displays) && displays.length ? displays : [primary];
	let area = primary;
	let position = null;

	if (saved && saved.width > 0 && saved.height > 0) {
		let best = 0;
		for (const candidate of areas) {
			const shared = overlap(saved, candidate);
			if (shared > best) {
				best = shared;
				area = candidate;
			}
		}
		if (best >= saved.width * saved.height * 0.5) position = saved;
	}

	const minWidth = Math.min(defaults.minWidth, area.width);
	const minHeight = Math.min(defaults.minHeight, area.height);
	const clamp = (value, min, max) => Math.max(min, Math.min(value, max));
	const width = clamp(position ? position.width : defaults.width, minWidth, area.width);
	const height = clamp(position ? position.height : defaults.height, minHeight, area.height);

	const out = { width, height, minWidth, minHeight, x: undefined, y: undefined, maximized: false };
	if (position) {
		out.x = clamp(position.x, area.x, area.x + area.width - width);
		out.y = clamp(position.y, area.y, area.y + area.height - height);
		out.maximized = position.maximized;
	}
	return out;
}

module.exports = { load, save, place };
