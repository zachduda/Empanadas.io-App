// The daily reward on Home, as the site's card and the iOS app's show it:
// the streak, this week of it with a flame for every day claimed (each a
// little bigger and livelier toward day 7), and Claim for today's peppers
// (10 a day, 50 from day 7 of a streak on). Its status comes with
// /v2/app/dashboard.php ("daily", dailyStatus() in the site's v2/_daily.php);
// the claim goes through the main process (claimDaily, /v2/app/daily.php).

import { h, replace, button, icon } from './dom.js';
import { num } from './format.js';

const calm = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// 0 to 1: how far a day is toward the week's big reward.
const heatOf = (day, d) => Math.min(Math.max(day, 1), d.streak_days) / d.streak_days;

function flame(lit, heat) {
	const node = h('span', { class: 'daily-flame' + (lit ? '' : ' is-out'), 'aria-hidden': 'true' });
	node.style.setProperty('--heat', heat.toFixed(3));
	return node;
}

// "5h 12m", "12m", "less than a minute".
function until(seconds) {
	const s = Math.max(0, Math.floor(seconds));
	const hours = Math.floor(s / 3600);
	const minutes = Math.floor((s % 3600) / 60);
	if (hours > 0) return hours + 'h ' + minutes + 'm';
	if (minutes > 0) return minutes + 'm';
	return 'less than a minute';
}

function subtitle(d) {
	if (d.claimed) return "Today's " + num(d.reward) + ' peppers are yours. Tomorrow pays ' + num(d.tomorrow) + '.';
	if (d.streak > 0) return "Claim today's " + num(d.reward) + ' peppers to keep your ' + num(d.streak) + '-day streak alive.';
	if (d.total > 0) return 'Your streak went out. Light it back up today!';
	return "Today's reward is " + num(d.reward) + ' peppers. Come back every day to build your streak.';
}

function hint(d) {
	if (d.day >= d.streak_days) return "You're on fire! Keep the streak going for " + num(d.streak_reward) + ' peppers every day.';
	const left = d.streak_days - d.day;
	if (left === 1) return 'Tomorrow is day ' + d.streak_days + ': ' + num(d.streak_reward) + ' peppers, and every day after it!';
	return 'Reach day ' + d.streak_days + ' for ' + num(d.streak_reward) + ' peppers every day. ' + left + ' days to go.';
}

// The card. Returns { el, update(daily, asOf, lit), destroy() }: Home keeps
// one and updates it, so the countdown and a claim under way carry over a
// refresh. claim() resolves to the claim's result ({ ok, data, error }).
export function dailyCard({ claim, toast }) {
	const el = h('section', { class: 'card daily-card', 'aria-label': 'Daily reward' });
	let daily = null;
	let asOf = Date.now();
	let claiming = false;
	let ticker = null;

	// Claimed, and the site's day has turned over since the answer came.
	const dueAgain = () => daily && daily.claimed && daily.next_in !== null && daily.next_in !== undefined &&
		Date.now() >= asOf + daily.next_in * 1000;

	function footer() {
		if (daily.claimed && !dueAgain()) {
			const left = daily.next_in !== null && daily.next_in !== undefined
				? (asOf + daily.next_in * 1000 - Date.now()) / 1000 : null;
			return h('div', { class: 'daily-wait' }, icon('clock'), left === null ? 'Claimed today' : 'Next reward in ' + until(left));
		}
		const amount = dueAgain() ? daily.tomorrow : daily.reward;
		const b = button(claiming ? 'Claiming...' : 'Claim ' + num(amount) + ' Peppers', onClaim,
			{ kind: 'pill large daily-claim' + (claiming ? '' : ' is-ready'), disabled: claiming || !navigator.onLine });
		if (!navigator.onLine) b.title = 'Needs a connection';
		return b;
	}

	function draw(lit) {
		if (!daily) return;
		const d = daily;
		const week = Array.isArray(d.week) ? d.week : [];
		el.classList.toggle('is-hot', d.streak >= d.streak_days);
		el.style.setProperty('--heat', (d.streak > 0 ? heatOf(d.streak, d) : 0).toFixed(3));
		replace(el,
			h('div', { class: 'daily-head' },
				h('span', { class: 'daily-badge', 'aria-hidden': 'true' }, icon('gift')),
				h('div', { class: 'daily-heading' },
					h('div', { class: 'daily-title' }, 'Daily Reward'),
					h('div', { class: 'daily-sub' }, subtitle(d))),
				h('span', { class: 'daily-streak' + (d.streak > 0 ? '' : ' is-out'), title: d.best > d.streak ? 'Best: ' + num(d.best) + ' days' : null },
					icon('bolt'), num(d.streak) + '-day streak')),
			h('ol', { class: 'daily-week', 'aria-label': 'This week of your streak' }, week.map((day) => {
				const big = day.reward >= d.streak_reward;
				return h('li', {
					class: 'daily-day' + (day.done ? ' is-done' : '') + (day.today ? ' is-today' : '') + (big ? ' is-big' : '') +
						(lit && day.today ? ' is-lit-now' : ''),
					'aria-label': 'Day ' + day.day + ', ' + num(day.reward) + ' peppers' + (day.done ? ', claimed' : day.today ? ', today' : '')
				},
				h('span', { class: 'daily-day-label' }, 'Day ' + day.day),
				flame(day.done, heatOf(day.day, d)),
				h('span', { class: 'daily-day-reward' }, icon('pepper'), num(day.reward)));
			})),
			h('div', { class: 'daily-foot' }, h('div', { class: 'daily-hint' }, hint(d)), footer()));
		if (lit) embers();
	}

	function embers() {
		if (calm()) return;
		const width = el.clientWidth || 600;
		for (let i = 0; i < 18; i += 1) {
			const ember = h('span', { class: 'daily-ember', 'aria-hidden': 'true' });
			ember.style.left = Math.round(Math.random() * width) + 'px';
			ember.style.setProperty('--dx', Math.round((Math.random() - 0.5) * 80) + 'px');
			ember.style.animationDelay = Math.round(Math.random() * 500) + 'ms';
			el.appendChild(ember);
			setTimeout(() => ember.remove(), 2400);
		}
	}

	async function onClaim() {
		if (claiming || !daily) return;
		claiming = true;
		draw(false);
		const result = await claim();
		claiming = false;
		if (result && result.ok && result.data && result.data.daily) {
			daily = result.data.daily;
			asOf = Date.now();
			draw(result.data.granted > 0);
			if (result.data.granted > 0) {
				toast('+' + num(result.data.granted) + ' peppers! ' +
					(daily.streak > 1 ? "That's a " + num(daily.streak) + '-day streak. Keep it burning!' : 'See you tomorrow!'), 'success');
			} else {
				toast("Today's reward is already yours. Come back tomorrow!", 'info');
			}
			return;
		}
		draw(false);
		const error = (result && result.error) || {};
		// A copy of the app from before the daily reward, showing the site's newer screens.
		if (error.code === 'invalid') toast('Update Empanadas.io to claim from here, or claim it on the website.', 'info');
		else toast(error.message || "Couldn't claim it. Try again in a moment.", 'error');
	}

	ticker = setInterval(() => { if (daily && daily.claimed && !claiming) draw(false); }, 30000);

	return {
		el,
		update(next, savedAt) {
			if (!next || typeof next !== 'object') return;
			daily = next;
			asOf = Number(savedAt) || Date.now();
			if (!claiming) draw(false);
		},
		destroy() {
			clearInterval(ticker);
		}
	};
}
