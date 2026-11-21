// Leaderboards: Spin, Flappy and Tower, from /v2/ios/leaderboard.php. Medals
// for the top three, the player's own row marked, a row opens the profile.
// Refreshes while showing, at the pace the site's cache rebuilds.

import { h, replace } from '../dom.js';
import { num, ago, GAMES, GAME_ORDER } from '../format.js';
import { load, staleBanner, errorState, skeleton } from '../data.js';
import { playerRow } from '../components.js';

const MEDALS = ['🥇', '🥈', '🥉'];

export function mount(container, { app, params }) {
	const inner = h('div', { class: 'content-inner narrow' });
	replace(container, inner);
	let game = GAME_ORDER.includes(params && params.game) ? params.game : 'spin';
	let last = null;
	let timer = null;

	function subtitle(name, row) {
		if (row.private) return 'Private profile';
		if (name === 'spin') return 'Prestige ' + num(row.prestige) + ' · ' + num(row.ascends) + ' ascensions';
		return row.recent !== undefined ? 'Last round ' + num(row.recent) : '';
	}

	function draw() {
		const result = last;
		const segmented = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Game' },
			GAME_ORDER.map((name) => h('button', {
				type: 'button',
				'aria-pressed': String(name === game),
				onclick: () => { game = name; draw(); }
			}, GAMES[name].name)));
		const head = h('div', { class: 'page-head' },
			h('div', null, h('h1', null, 'Leaderboards'),
				h('div', { class: 'sub' }, result && result.data ? 'Updated ' + ago((result.data.generated || 0) * 1000) : ' ')),
			h('div', { class: 'actions' }, segmented));

		if (!result) {
			replace(inner, head, skeleton(8, 40));
			return;
		}
		if (!result.data) {
			replace(inner, head, errorState(result, refresh));
			return;
		}
		const rows = Array.isArray(result.data[game]) ? result.data[game] : [];
		const you = result.data.you;
		const unit = game === 'spin' ? 'spins' : game === 'flappy' ? 'points' : 'floors';
		replace(inner, staleBanner(result, refresh), head,
			h('div', { class: 'card flush' }, rows.length ? h('div', { class: 'list' }, rows.map((row) => {
				const r = Number(row.rank) || 0;
				const rank = h('div', { class: 'rank' + (r <= 3 ? ' medal' : '') }, r <= 3 ? MEDALS[r - 1] : String(r));
				const el = playerRow(row, {
					subtitle: subtitle(game, row),
					me: row.id === you,
					trail: row.private ? null : h('div', { style: { textAlign: 'right' } },
						h('div', { class: 'score' }, num(row.score)), h('div', { class: 'muted small' }, unit)),
					onOpen: () => app.navigate({ screen: 'profile', id: row.id })
				});
				el.insertBefore(rank, el.firstChild);
				return el;
			})) : h('div', { class: 'list-empty' }, 'Nobody on this board yet.')));
	}

	function schedule() {
		clearTimeout(timer);
		const ttl = last && last.data && last.data.ttl ? Number(last.data.ttl) : 45;
		const age = last && last.data && last.data.age ? Number(last.data.age) : 0;
		const wait = Math.max(15, ttl - age + 2) * 1000;
		timer = setTimeout(() => refresh().finally(schedule), wait);
	}

	function render(result) {
		if (!result || (!result.data && last && last.data)) return;
		last = result;
		draw();
	}

	function refresh() {
		return load('leaderboard', {}, render, { cached: false });
	}

	draw();
	load('leaderboard', {}, render).finally(schedule);

	return {
		title: 'Leaderboards',
		refresh,
		destroy() { clearTimeout(timer); }
	};
}
