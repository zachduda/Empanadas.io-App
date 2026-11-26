// Pieces more than one screen draws.

import { h, svg, avatar, picture, icon } from './dom.js';
import { num, short, GAMES } from './format.js';

// The games' symbols, solid white shapes on a 24-unit grid for the games'
// own colours (app.css, .game-art): the iOS app's way of showing a game, a
// symbol on its colour. Spin is two arrows chasing round a loop, Flappy a
// bird, Tower a stack of layers.
const SOLID = { stroke: 'currentColor', 'stroke-linejoin': 'round' };

// One of Spin's two arrows (the other is this turned half way round): an arc
// of the loop and a head on the end of it, along the arc's own direction.
function loopArrow(turn) {
	const at = turn ? { transform: 'rotate(' + turn + ' 12 12)' } : {};
	return [
		['path', Object.assign({ d: 'M5.11 8.79A7.6 7.6 0 0 1 15.8 5.42', fill: 'none', stroke: 'currentColor', 'stroke-width': 2.6, 'stroke-linecap': 'round' }, at)],
		['path', Object.assign({ d: 'M17.45 2.56 19.61 7.62 14.15 8.28z', 'stroke-width': 1.2 }, SOLID, at)]
	];
}

const GLYPHS = {
	spin: [...loopArrow(0), ...loopArrow(180)],
	flappy: [
		// The body, with the eye and the line of the wing cut out of it.
		['path', { 'fill-rule': 'evenodd', d: 'M11.6 6.2a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM14.9 9.7a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6zM7.3 14.4C8.5 11.8 11.6 11.3 13.6 13.3 11.4 12.9 9 13.3 7.3 14.4z' }],
		['path', Object.assign({ d: 'M8 10.2 3.2 8 5.4 14.4z', 'stroke-width': 1.4 }, SOLID)],
		['path', Object.assign({ d: 'M17.4 10.3 22 12.4 17.6 14.6z', 'stroke-width': 1.4 }, SOLID)]
	],
	tower: [
		['path', Object.assign({ d: 'M12 3 20.6 7.3 12 11.6 3.4 7.3z', 'stroke-width': 1.4 }, SOLID)],
		['path', Object.assign({ d: 'M3.4 11 12 15.3 20.6 11v1.9L12 17.2 3.4 12.9z', 'stroke-width': 1.4 }, SOLID)],
		['path', Object.assign({ d: 'M3.4 16.2 12 20.5 20.6 16.2v1.9L12 22.4 3.4 18.1z', 'stroke-width': 1.4 }, SOLID)]
	]
};

// The bird is the shortest of the three, so it is drawn a little larger.
const BOXES = { flappy: '1.4 2.2 22 22' };

export function gameGlyph(name) {
	return svg('svg', { viewBox: BOXES[name] || '0 0 24 24', class: 'game-glyph', 'aria-hidden': 'true', focusable: 'false' },
		(GLYPHS[name] || []).map(([tag, attrs]) => svg(tag, attrs)));
}

// A game's picture: its symbol on its colour, as the iOS app draws it. Big,
// with its name (and badge) on it, for the Games screen; compact, the
// symbol alone, for the small cards on Home.
export function gameArt(name, { label = true, badge = null, compact = false } = {}) {
	if (compact) return h('div', { class: 'game-art compact ' + name }, gameGlyph(name));
	return h('div', { class: 'game-art ' + name },
		h('div', { class: 'art-watermark' }, gameGlyph(name)),
		h('div', { class: 'art-tile' }, gameGlyph(name)),
		label ? h('div', { class: 'art-label' }, GAMES[name] ? GAMES[name].name : name) : null,
		badge ? h('div', { class: 'art-badge' }, badge) : null);
}

// What an account's experience came from, biggest first, a bar for each:
// [{ label, xp, percent }], as the profile gives it.
export function xpBreakdown(parts) {
	return h('div', { class: 'breakdown' }, parts.map((part) =>
		h('div', { class: 'item' },
			h('span', null, part.label),
			h('span', { class: 'muted num' }, num(part.xp) + ' XP'),
			h('div', { class: 'meter' }, h('span', { style: { width: Math.min(100, Number(part.percent) || 0) + '%' } })))));
}

export function presenceOf(state) {
	const s = String(state || '').toLowerCase();
	if (s === 'online') return 'online';
	if (s === 'away' || s === 'recent' || s === 'idle') return 'away';
	return 'offline';
}

export function tile(label, value, { iconName, title } = {}) {
	return h('div', { class: 'tile', title: title || null },
		h('div', { class: 'label' }, iconName ? icon(iconName) : null, label),
		h('div', { class: 'value num' }, value));
}

export function numberTile(label, value, iconName) {
	return tile(label, short(value), { iconName, title: num(value) });
}

// One player in a list. onOpen opens their profile.
export function playerRow(player, { subtitle, trail, onOpen, me = false } = {}) {
	const row = h(onOpen ? 'button' : 'div', {
		type: onOpen ? 'button' : null,
		class: 'list-row' + (me ? ' me' : '') + (onOpen ? ' clickable' : '')
	},
	avatar(player.pfp, null, player.state ? presenceOf(player.state) : null),
	h('div', { class: 'main' },
		h('div', { class: 'title' }, player.username || 'Player'),
		subtitle ? h('div', { class: 'subtitle' }, subtitle) : null),
	trail ? h('div', { class: 'trail' }, trail) : null);
	if (onOpen) row.addEventListener('click', (e) => {
		if (e.target.closest('.trail button')) return;
		onOpen();
	});
	return row;
}

export function badges(profile) {
	return [
		profile.admin ? h('span', { class: 'badge accent', title: 'Empanadas.io staff' }, icon('shield'), 'Staff') : null,
		profile.supporter ? h('span', { class: 'badge gold', title: 'Supports Empanadas.io' }, icon('star'), 'Supporter') : null,
		profile.vip ? h('span', { class: 'badge gold' }, 'VIP') : null
	];
}

// The site's pictures are paths ("/pfp/lg/x.png"); the cache takes them as given.
export { picture };

// Settings' rows (settings.js and appsettings.js, one screen): a title, what
// it does, and its control, with an icon in front if it has one.
export function setting(title, desc, control, leadIcon) {
	return h('div', { class: 'setting' },
		leadIcon ? icon(leadIcon, 'lead') : null,
		h('div', { class: 'main' }, h('div', { class: 'title' }, title), desc ? h('div', { class: 'desc' }, desc) : null),
		control ? h('div', { class: 'control' }, control) : null);
}

// A titled card of setting() rows.
export function settingsGroup(title, rows) {
	return h('section', { class: 'settings-group' }, title ? h('h2', null, title) : null, h('div', { class: 'card' }, rows));
}

// A switch saved as it changes: onChange(on) resolves false to put it back.
export function settingSwitch(checked, onChange, { disabled = false, label } = {}) {
	const input = h('input', { type: 'checkbox', class: 'switch', role: 'switch', 'aria-label': label, disabled });
	input.checked = !!checked;
	input.addEventListener('change', async () => {
		const want = input.checked;
		input.disabled = true;
		const ok = await onChange(want);
		input.disabled = false;
		if (ok === false) input.checked = !want;
	});
	return input;
}
