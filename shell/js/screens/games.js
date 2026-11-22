// Games: Jump Back In for the game played last, then a card per game with
// when it was played here, the player's place on its leaderboard, three of
// their numbers, and whether it is downloaded for offline play. A
// right-click offers its leaderboard and Report a Problem.

import { h, replace, button, icon } from '../dom.js';
import { num, ago, bytes, GAMES, GAME_ORDER } from '../format.js';
import { gameArt } from '../components.js';

// Report a Problem: the site's "bug_report" feedback subject
// (feedbackSubjects() in its v2/_lib.php).
const BUG_REPORT = 5;
const REPORT_REASON = { spin: BUG_REPORT, flappy: BUG_REPORT, tower: BUG_REPORT };

export function mount(container, { app }) {
	const inner = h('div', { class: 'content-inner' });
	replace(container, inner);

	let status = app.state.games;
	let dashboard = app.state.dashboard;
	let board = null;

	function rankIn(name) {
		if (!board || !Array.isArray(board[name])) return null;
		const me = board[name].find((row) => row.id === board.you);
		return me ? me.rank : null;
	}

	function statsOf(name) {
		const d = dashboard || {};
		if (name === 'spin') {
			const s = d.spin || {};
			return [['Spins', s.lifetime], ['Prestige', s.prestige], ['Ascensions', s.ascends]];
		}
		const g = d[name] || {};
		return [['Best', g.high], ['Last', g.recent], ['Rounds', g.played]];
	}

	function offlineBadge(name) {
		if (!status) return null;
		if (status.games && status.games[name] && status.games[name].ready) {
			return h('span', { class: 'badge success', title: 'Downloaded to this computer: plays without a connection' }, icon('cloud'), 'Offline ready');
		}
		if (status.syncing) return h('span', { class: 'badge' }, 'Downloading…');
		return h('span', { class: 'badge', title: 'Downloaded the first time you play it, or from Settings' }, 'Online only');
	}

	function menu(name) {
		app.contextMenu([
			{ id: 'play', label: 'Play ' + GAMES[name].full },
			{ type: 'separator' },
			{ id: 'board', label: 'View Leaderboard' },
			{ id: 'report', label: 'Report a Problem…' }
		], (id) => {
			if (id === 'play') app.play(name);
			if (id === 'board') app.navigate({ screen: 'leaderboard', game: name });
			if (id === 'report') app.navigate({ screen: 'feedback', reason: REPORT_REASON[name] });
		});
	}

	function card(name) {
		const history = (status && status.history) || {};
		const rank = rankIn(name);
		const playing = status && status.playing === name;
		const el = h('div', { class: 'card game-card' },
			gameArt(name, { badge: rank ? h('span', { class: 'badge' }, '#' + num(rank)) : null }),
			h('div', null,
				h('h3', { style: { fontSize: '16px' } }, GAMES[name].full),
				h('div', { class: 'muted small', style: { marginTop: '2px' } }, GAMES[name].blurb)),
			h('div', { class: 'stats' }, statsOf(name).map(([k, v]) =>
				h('div', { class: 'stat' }, h('div', { class: 'k' }, k), h('div', { class: 'v', title: num(v) }, num(v))))),
			h('div', { class: 'meta' },
				offlineBadge(name),
				h('span', null, history[name] ? 'Played ' + ago(history[name]) : 'Not played on this computer yet')),
			h('div', { class: 'foot' },
				button(playing ? 'Playing' : 'Play', () => app.play(name), { kind: 'primary', icon: 'play' }),
				h('div', { class: 'spacer' }),
				h('button', { type: 'button', class: 'icon-btn', title: 'More', 'aria-label': 'More', onclick: () => menu(name) }, icon('more'))));
		el.addEventListener('contextmenu', (e) => { e.preventDefault(); menu(name); });
		return el;
	}

	function draw() {
		const history = (status && status.history) || {};
		const recent = GAME_ORDER.slice().sort((a, b) => (history[b] || 0) - (history[a] || 0))[0];
		const hasRecent = !!history[recent];

		const hero = hasRecent ? h('div', { class: 'card hero', style: { marginBottom: '18px' } },
			gameArt(recent),
			h('div', null,
				h('div', { class: 'eyebrow' }, 'Jump back in'),
				h('h2', null, GAMES[recent].full),
				h('p', { class: 'muted', style: { margin: '4px 0 14px' } }, 'Played ' + ago(history[recent]) + '. ' + GAMES[recent].blurb),
				button('Play ' + GAMES[recent].name, () => app.play(recent), { kind: 'primary large', icon: 'play' }))) : null;

		const foot = status ? h('div', { class: 'muted small games-foot' },
			icon('download'),
			h('span', null, status.files ? num(status.files) + ' game files kept on this computer (' + bytes(status.bytes) + ')' : 'The games download the first time you open the app.'),
			status.syncedAt ? h('span', null, '· checked for updates ' + ago(status.syncedAt)) : null,
			status.syncing ? h('span', { class: 'row-flex' }, h('span', { class: 'spinner' }), 'Updating ' + num(status.progress.done) + ' of ' + num(status.progress.total)) : null,
			h('div', { class: 'spacer' }),
			button('Check for Game Updates', async (e) => {
				const btn = e.currentTarget;
				btn.disabled = true;
				status = await window.native.games.update();
				draw();
			}, { kind: 'small', disabled: status.syncing || !navigator.onLine })) : null;

		replace(inner,
			h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Games'), h('div', { class: 'sub' }, 'Kept on this computer, so they start fast and work offline.'))),
			hero,
			h('div', { class: 'grid three' }, GAME_ORDER.map(card)),
			foot);
	}

	draw();
	window.native.games.status().then((s) => { status = s; draw(); });
	window.native.data.cached('leaderboard').then((r) => { if (r && r.data) { board = r.data; draw(); } });
	if (!dashboard) window.native.data.cached('dashboard').then((r) => { if (r && r.data) { dashboard = r.data; draw(); } });

	const offs = [
		app.on('games', (s) => { status = s; draw(); }),
		app.on('dashboard', (r) => { if (r && r.data) { dashboard = r.data; draw(); } })
	];

	return {
		title: 'Games',
		async refresh() {
			status = await window.native.games.status();
			const b = await window.native.data.load('leaderboard');
			if (b && b.data) board = b.data;
			draw();
		},
		destroy() { offs.forEach((off) => off()); }
	};
}
