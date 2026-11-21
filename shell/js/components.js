// Pieces more than one screen draws.

import { h, avatar, picture, icon } from './dom.js';
import { num, short, GAMES } from './format.js';

const EMPANADA = '/Content/Images/empanada.webp';

export function gameArt(name, { label = true, badge = null } = {}) {
	const img = h('img', { src: picture(EMPANADA), alt: '', draggable: 'false' });
	img.addEventListener('error', () => { img.src = 'images/logo.png'; }, { once: true });
	return h('div', { class: 'game-art ' + name },
		img,
		label ? h('div', { class: 'art-label' }, GAMES[name] ? GAMES[name].name : name) : null,
		badge ? h('div', { class: 'art-badge' }, badge) : null);
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
