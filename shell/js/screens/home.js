// Home: the dashboard, from /v2/app/dashboard.php. The stats, a card per
// game, the Spin Progress chart, experience and rank, and friends online.

import { h, replace, button, icon, avatar } from '../dom.js';
import { num, short, plural, greeting, pumpkinSeason, GAMES, GAME_ORDER } from '../format.js';
import { load, staleBanner, errorState, skeleton, skeletonCards } from '../data.js';
import { gameArt, numberTile, presenceOf, xpBreakdown } from '../components.js';
import { spinChart } from '../chart.js';
import { checkForNew } from './updates.js';

const pct = (value) => Math.max(0, Math.min(100, Number(value) || 0)) + '%';
const calm = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function mount(container, { app }) {
	const inner = h('div', { class: 'content-inner home' });
	replace(container, inner);
	replace(inner, skeleton(2, 26), h('div', { style: { height: '20px' } }), skeletonCards(3, 90));

	let chart = null;
	let last = null;
	let shown = false;
	let counting = [];
	let gone = false;

	// What the experience came from, under the rank. The dashboard does not
	// carry it (the profile does), so it is asked for after the dashboard, and
	// again whenever the XP has moved since.
	let parts = null; // [{ label, xp, percent }], or null until there are some
	let partsFor = null; // the XP total they were asked for at
	let partsBusy = false;
	let partsHost = null; // where they go in the card on screen
	let latestTotal = null;

	function drawParts() {
		if (!partsHost) return;
		if (parts && parts.length) replace(partsHost, xpBreakdown(parts));
		else if (partsBusy && !parts) replace(partsHost, skeleton(3, 12));
		else if (!parts) replace(partsHost, h('div', { class: 'muted small' }, "The breakdown isn't available right now."));
		else replace(partsHost);
	}

	async function loadParts(first) {
		if (partsBusy || gone) return;
		partsBusy = true;
		if (!parts) drawParts(); // the skeleton, not the note for when it fails
		const total = latestTotal;
		const result = await load('profile', {}, (r) => {
			const xp = r && r.data && r.data.xp;
			if (xp && Array.isArray(xp.breakdown)) {
				parts = xp.breakdown;
				drawParts();
			}
		}, { cached: first });
		partsBusy = false;
		if (result && result.ok) {
			partsFor = total;
			// The XP moved while this was on its way: once more, for the new one.
			if (!gone && latestTotal !== total) return loadParts(false);
		}
		drawParts();
	}

	// A tile's number rolls up from zero, easing out, the first time Home shows.
	function countUp(el, value) {
		const target = Number(value);
		if (!el || !Number.isFinite(target) || target === 0 || calm()) return;
		const started = performance.now();
		const duration = 900 + Math.min(500, Math.log10(Math.abs(target) + 1) * 90);
		const frame = (now) => {
			const t = Math.min(1, (now - started) / duration);
			const eased = 1 - Math.pow(1 - t, 4);
			el.textContent = short(t < 1 ? Math.round(target * eased) : target);
			if (t < 1) counting.push(requestAnimationFrame(frame));
		};
		el.textContent = short(0);
		counting.push(requestAnimationFrame(frame));
	}

	function render(result) {
		if (!result) return;
		if (!result.data) {
			if (!last) replace(inner, errorState(result, refresh));
			return;
		}
		last = result;
		counting.forEach(cancelAnimationFrame);
		counting = [];
		const d = result.data;
		app.state.dashboard = d;
		app.setPendingFriends(d.friends && d.friends.pending);

		const account = d.account || {};
		const xp = d.xp || {};
		const spin = d.spin || {};
		const flappy = d.flappy || {};
		const tower = d.tower || {};
		const friends = d.friends || { list: [] };

		// The first picture of Home rises in, card by card, and its numbers
		// count up. Later refreshes just swap the numbers in.
		const entering = !shown;
		shown = true;
		inner.classList.toggle('entering', entering);
		let order = 0;
		const rise = (el) => {
			if (el) {
				el.classList.add('rise');
				el.style.setProperty('--i', String(order++));
			}
			return el;
		};

		const tileDefs = [
			['Lifetime Spins', spin.lifetime, 'refresh'],
			['Prestige', spin.prestige, 'star'],
			['Ascensions', spin.ascends, 'spark'],
			['Flappy Best', flappy.high, 'trophy'],
			['Tower Best', tower.high, 'trophy'],
			['Peppers', d.peppers, 'pepper']
		];
		if (pumpkinSeason()) tileDefs.push(['Pumpkins 🎃', d.pumpkins, null]);
		const tiles = tileDefs.map(([label, value, iconName], i) => {
			const t = numberTile(label, value, iconName);
			t.classList.add('bubble-tile', 'hue-' + (i % 3));
			if (entering) countUp(t.querySelector('.value'), value);
			return t;
		});

		const gameLine = {
			spin: ['Prestige ' + num(spin.prestige) + ' · ' + plural(spin.ascends, 'ascension'), spin.progress],
			flappy: ['Best ' + num(flappy.high) + ' · Last ' + num(flappy.recent), flappy.progress],
			tower: ['Best ' + num(tower.high) + ' · Last ' + num(tower.recent), tower.progress]
		};

		const miniGames = h('div', { class: 'home-games' }, GAME_ORDER.map((name) => {
			const [line, progress] = gameLine[name];
			const play = button('Play', () => app.play(name), { kind: 'play small pill', icon: 'play' });
			const card = h('div', { class: 'card mini-game ' + name },
				gameArt(name, { compact: true }),
				h('div', { class: 'info' },
					h('div', { class: 'name' }, GAMES[name].full),
					h('div', { class: 'stat' }, line),
					h('div', { class: 'meter' + (name === 'spin' ? ' gold' : '') }, h('span', { style: { width: pct(progress) } }))),
				play);
			card.addEventListener('dblclick', () => app.play(name));
			return rise(card);
		}));

		const chartCard = h('div', { class: 'card soft' },
			h('div', { class: 'card-title' }, h('span', { class: 'title-chip' }, icon('refresh')), 'Spin Progress',
				h('a', { class: 'aside', href: '#', onclick: (e) => { e.preventDefault(); app.navigate({ screen: 'savepoints' }); } }, 'Missing or overwrote your progress?')));
		if (chart) chart.destroy();
		chart = spinChart(d.spin_history || []);
		chartCard.appendChild(chart.el);

		// A site that sends the breakdown with the dashboard needs no second ask.
		latestTotal = xp.total;
		if (Array.isArray(xp.breakdown)) {
			parts = xp.breakdown;
			partsFor = xp.total;
		}
		partsHost = h('div', { class: 'xp-parts' });
		drawParts();

		const xpCard = h('div', { class: 'card soft' },
			h('div', { class: 'card-title' }, h('span', { class: 'title-chip gold' }, icon('star')), 'Experience', h('span', { class: 'aside' }, num(xp.total) + ' XP')),
			h('div', { class: 'xp-rank' },
				h('div', { class: 'xp-icon' }, xp.icon || '⭐'),
				h('div', { style: { flex: '1', minWidth: '0' } },
					h('div', { style: { fontWeight: '700', fontSize: '15px' } }, xp.rank || 'Rookie'),
					h('div', { class: 'muted small' }, xp.next_rank && xp.next
						? num(Math.max(0, xp.next - xp.total)) + ' XP to ' + xp.next_rank
						: 'Top rank. Nicely done.'),
					h('div', { class: 'meter gold', style: { marginTop: '8px' } }, h('span', { style: { width: pct(xp.progress) } })))),
			partsHost);

		const list = Array.isArray(friends.list) ? friends.list : [];
		const friendsCard = h('div', { class: 'card soft' },
			h('div', { class: 'card-title' }, h('span', { class: 'title-chip' }, icon('users')), 'Friends',
				h('span', { class: 'aside' }, num(friends.online) + ' online · ' + num(friends.total) + ' total')),
			friends.pending ? h('div', { class: 'banner', style: { marginBottom: '10px' } },
				icon('userPlus'), plural(friends.pending, 'friend request') + ' waiting',
				h('div', { class: 'actions' }, button('Review', () => app.navigate({ screen: 'friends' }), { kind: 'small primary pill' }))) : null,
			list.length
				? h('div', null, list.map((f) => {
					const chip = h('button', { type: 'button', class: 'friend-chip' },
						avatar(f.pfp, 'sm', presenceOf(f.state)),
						h('div', { style: { minWidth: '0' } }, h('div', { class: 'name' }, f.username), h('div', { class: 'state' }, f.label || f.state)));
					chip.addEventListener('click', () => app.navigate({ screen: 'profile', id: f.uuid }));
					return chip;
				}))
				: h('div', { class: 'muted', style: { padding: '8px 0' } }, 'No friends yet. Find some!'),
			h('div', { style: { marginTop: '10px' } }, button('Find Friends', () => app.navigate({ screen: 'friends', search: true }), { kind: 'quiet small pill', icon: 'search' })));

		const hero = h('section', { class: 'home-hero greeting' },
			h('div', { class: 'bubbles', 'aria-hidden': 'true' }, [0, 1, 2, 3, 4].map((n) => h('span', { class: 'bubble b' + n }))),
			h('div', { class: 'hero-avatar' }, avatar(account.pfp, 'lg')),
			h('div', { class: 'hero-text' },
				h('div', { class: 'hero-eyebrow' }, greeting()),
				h('h1', null, (account.username || 'friend') + '!', h('span', { class: 'wave', 'aria-hidden': 'true' }, '👋')),
				h('div', { class: 'sub' },
					xp.rank ? h('span', { class: 'badge gold' }, (xp.icon ? xp.icon + ' ' : '') + xp.rank) : null,
					account.days !== undefined ? h('span', { class: 'badge sky' }, icon('clock'), 'Playing for ' + plural(account.days, 'day')) : null,
					h('span', { class: 'badge sky' }, h('span', { class: 'live-dot' }), plural(friends.online, 'friend') + ' online'))),
			h('div', { class: 'hero-cta' },
				button('Play Spin', () => app.play('spin'), { kind: 'primary pill large', icon: 'play' })));

		replace(inner,
			staleBanner(result, refresh),
			rise(hero),
			account.email_verified === false ? rise(h('div', { class: 'banner warn' }, icon('mail'),
				'Verify your email address to unlock your bio, friend requests and more.',
				h('div', { class: 'actions' }, button('Verify', () => window.native.site.open('verifyEmail'), { kind: 'small' })))) : null,
			h('div', { class: 'grid tiles home-tiles' }, tiles.map(rise)),
			h('div', { class: 'stack' },
				miniGames,
				rise(chartCard),
				h('div', { class: 'grid two' }, rise(xpCard), rise(friendsCard))));
		if (chart) requestAnimationFrame(() => chart.update(d.spin_history || []));
		if (partsFor !== xp.total) loadParts(!parts);
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
			gone = true;
			off();
			counting.forEach(cancelAnimationFrame);
			if (chart) chart.destroy();
		}
	};
}
