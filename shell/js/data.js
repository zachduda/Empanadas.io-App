// A screen's data: what was kept on this computer first, straight away, then
// the site's answer when it comes. render(result) is called with each:
//
//   { ok: true,  data, savedAt, fresh }           the site's answer, or the kept one
//   { ok: false, error, data?, savedAt? }         no answer; data is the kept one, if any

import { h, icon, button } from './dom.js';
import { ago } from './format.js';

export async function load(key, params, render, { cached = true } = {}) {
	let shown = false;
	if (cached) {
		const kept = await window.native.data.cached(key, params || {});
		if (kept && kept.ok && kept.data) {
			render(kept, false);
			shown = true;
		}
	}
	const result = await window.native.data.load(key, params || {});
	render(result, shown);
	return result;
}

// Above a screen showing kept data because the site could not be asked.
export function staleBanner(result, retry) {
	if (!result || result.ok || !result.data) return null;
	const offline = result.error && result.error.code === 'network';
	return h('div', { class: 'banner warn' },
		icon(offline ? 'offline' : 'alert'),
		h('span', null, (offline ? "You're offline. " : result.error.message + ' ') + 'Showing what was saved ' + ago(result.savedAt) + '.'),
		retry ? h('div', { class: 'actions' }, button('Try Again', retry, { kind: 'small' })) : null);
}

// In place of a screen that has nothing to show.
export function errorState(result, retry) {
	const error = (result && result.error) || {};
	const offline = error.code === 'network';
	return h('div', { class: 'empty-state' },
		h('h2', null, offline ? "You're offline" : "Couldn't load this"),
		h('p', null, error.message || 'Something went wrong.'),
		retry ? h('div', { class: 'actions' }, button('Try Again', retry, { kind: 'primary' })) : null);
}

export function skeleton(lines = 3, height = 18) {
	return h('div', { class: 'stack', 'aria-hidden': 'true' },
		Array.from({ length: lines }, (_, i) => h('div', { class: 'skeleton', style: { height: height + 'px', width: (90 - i * 12) + '%' } })));
}

export function skeletonCards(count = 3, height = 120) {
	return h('div', { class: 'grid three', 'aria-hidden': 'true' },
		Array.from({ length: count }, () => h('div', { class: 'skeleton', style: { height: height + 'px', borderRadius: '12px' } })));
}
