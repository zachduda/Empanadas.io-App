// Home: the dashboard, from /v2/app/dashboard.php. The stats, a card per
// game, the Spin Progress chart, experience and rank, and friends online.

import { h, replace, button, icon, avatar } from '../dom.js';
import { num, short, plural, greeting, GAMES, GAME_ORDER } from '../format.js';
import { load, staleBanner, errorState, skeleton, skeletonCards } from '../data.js';
import { gameArt, numberTile, presenceOf } from '../components.js';
import { spinChart } from '../chart.js';
import { checkForNew } from './updates.js';

export function mount(container, { app }) {
	const inner = h('div', { class: 'content-inner' });
	replace(container, inner);
	replace(inner, skeleton(2, 26), h('div', { style: { height: '20px' } }), skeletonCards(3, 90));

	let chart = null;
	let last = null;

	function render(result) {
		if (!result) return;
		if (!result.data) {
			if (!last) replace(inner, errorState(result, refresh));
			return;
		}
		last = result;
		const d = result.data;
		app.state.dashboard = d;
		app.setPendingFriends(d.friends && d.friends.pending);

		const account = d.account || {};
		const xp = d.xp || {};
		const spin = d.spin || {};
		const flappy = d.flappy || {};
		const tower = d.tower || {};
		const friends = d.friends || { list: [] };

		const tiles = [
			numberTile('Lifetime Spins', spin.lifetime, 'refresh'),
			numberTile('Prestige', spin.prestige, 'star'),
			numberTile('Ascensions', spin.ascends, 'spark'),
			numberTile('Flappy Best', flappy.high, 'trophy'),
			numberTile('Tower Best', tower.high, 'trophy'),
			numberTile('Peppers', d.peppers, 'pepper')
		];
		if (d.pumpkin_season || d.pumpkins) tiles.push(numberTile('Pumpkins 🎃', d.pumpkins, null));

		const gameLine = {
			spin: ['Prestige ' + num(spin.prestige) + ' · ' + plural(spin.ascends, 'ascension'), spin.progress],
			flappy: ['Best ' + num(flappy.high) + ' · Last ' + num(flappy.recent), flappy.progress],
			tower: ['Best ' + num(tower.high) + ' · Last ' + num(tower.recent), tower.progress]
		};

		const miniGames = h('div', { class: 'home-games' }, GAME_ORDER.map((name) => {
			const [line, progress] = gameLine[name];
			const play = button('Play', () => app.play(name), { kind: 'play small', icon: 'play' });
			const card = h('div', { class: 'card mini-game' },
				gameArt(name, { label: false }),
				h('div', { class: 'info' },
					h('div', { class: 'name' }, GAMES[name].full),
					h('div', { class: 'stat' }, line),
					h('div', { class: 'meter' + (name === 'spin' ? ' gold' : '') }, h('span', { style: { width: Math.max(0, Math.min(100, Number(progress) || 0)) + '%' } }))),
				play);
			card.addEventListener('dblclick', () => app.play(name));
			return card;
		}));

		const chartCard = h('div', { class: 'card' },
			h('div', { class: 'card-title' }, 'Spin Progress',
				h('a', { class: 'aside', href: '#', onclick: (e) => { e.preventDefault(); app.navigate({ screen: 'savepoints' }); } }, 'Missing or overwrote your progress?')));
		if (chart) chart.destroy();
		chart = spinChart(d.spin_history || []);
		chartCard.appendChild(chart.el);

		const xpCard = h('div', { class: 'card' },
			h('div', { class: 'card-title' }, 'Experience', h('span', { class: 'aside' }, num(xp.total) + ' XP')),
			h('div', { class: 'xp-rank' },
				h('div', { class: 'xp-icon' }, xp.icon || '⭐'),
				h('div', { style: { flex: '1', minWidth: '0' } },
					h('div', { style: { fontWeight: '700', fontSize: '15px' } }, xp.rank || 'Rookie'),
					h('div', { class: 'muted small' }, xp.next_rank && xp.next
						? num(Math.max(0, xp.next - xp.total)) + ' XP to ' + xp.next_rank
						: 'Top rank. Nicely done.'),
					h('div', { class: 'meter gold', style: { marginTop: '8px' } }, h('span', { style: { width: Math.max(0, Math.min(100, Number(xp.progress) || 0)) + '%' } })))),
			h('div', { style: { marginTop: '14px' } },
				button('See What Earned It', () => app.navigate({ screen: 'profile' }), { kind: 'quiet small' })));

		const list = Array.isArray(friends.list) ? friends.list : [];
		const friendsCard = h('div', { class: 'card' },
			h('div', { class: 'card-title' }, 'Friends',
				h('span', { class: 'aside' }, num(friends.online) + ' online · ' + num(friends.total) + ' total')),
			friends.pending ? h('div', { class: 'banner', style: { marginBottom: '10px' } },
				icon('userPlus'), plural(friends.pending, 'friend request') + ' waiting',
				h('div', { class: 'actions' }, button('Review', () => app.navigate({ screen: 'friends' }), { kind: 'small primary' }))) : null,
			list.length
				? h('div', null, list.map((f) => {
					const chip = h('button', { type: 'button', class: 'friend-chip' },
						avatar(f.pfp, 'sm', presenceOf(f.state)),
						h('div', { style: { minWidth: '0' } }, h('div', { class: 'name' }, f.username), h('div', { class: 'state' }, f.label || f.state)));
					chip.addEventListener('click', () => app.navigate({ screen: 'profile', id: f.uuid }));
					return chip;
				}))
				: h('div', { class: 'muted', style: { padding: '8px 0' } }, 'No friends yet. Find some!'),
			h('div', { style: { marginTop: '10px' } }, button('Find Friends', () => app.navigate({ screen: 'friends', search: true }), { kind: 'quiet small', icon: 'search' })));

		replace(inner,
			staleBanner(result, refresh),
			h('div', { class: 'greeting' },
				avatar(account.pfp, 'md'),
				h('div', null,
					h('h1', null, greeting() + ', ' + (account.username || 'friend') + '!'),
					h('div', { class: 'sub' },
						xp.rank ? h('span', { class: 'badge gold' }, (xp.icon ? xp.icon + ' ' : '') + xp.rank) : null,
						account.days !== undefined ? h('span', null, 'Playing for ' + plural(account.days, 'day')) : null))),
			account.email_verified === false ? h('div', { class: 'banner warn' }, icon('mail'),
				'Verify your email address to unlock your bio, friend requests and more.',
				h('div', { class: 'actions' }, button('Verify', () => window.native.site.open('verifyEmail'), { kind: 'small' }))) : null,
			h('div', { class: 'grid tiles', style: { marginBottom: '18px' } }, tiles),
			h('div', { class: 'stack' },
				miniGames,
				chartCard,
				h('div', { class: 'grid two' }, xpCard, friendsCard)));
		if (chart) requestAnimationFrame(() => chart.update(d.spin_history || []));
	}

	function refresh() {
		return load('dashboard', {}, render, { cached: false });
	}

	load('dashboard', {}, render);
	checkForNew(app);
	const off = app.on('dashboard', render);

	return {
		title: 'Home',
		refresh,
		destroy() {
			off();
			if (chart) chart.destroy();
		}
	};
}
