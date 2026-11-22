// Updates: the site's announcements, newest first, one post a request as the
// site's own Updates page reads them (api.empanadas.io/v1/updates.php).
// The ones posted since the player last looked are marked New, and the bell
// in the title bar has a dot while there is one.

import { h, replace, button, avatar, icon } from '../dom.js';
import { dayLabel } from '../format.js';
import { sanitize } from '../sanitize.js';

const SEEN_KEY = 'updates.seen';
let lastCheck = 0;

function seen() {
	try { return localStorage.getItem(SEEN_KEY); } catch (err) { return null; }
}

function markSeen(id) {
	try { localStorage.setItem(SEEN_KEY, String(id)); } catch (err) { /* only a dot */ }
}

// At most every ten minutes, the time the site caches the answer for.
export async function checkForNew(app) {
	if (Date.now() - lastCheck < 10 * 60 * 1000) return;
	lastCheck = Date.now();
	const result = await window.native.data.load('announcement', { page: 0 });
	const post = result && result.data && result.data.found ? result.data : null;
	if (!post || !post.id) return;
	const before = seen();
	// The first time, the newest counts as seen, as the site has a new
	// account start with everything read.
	if (!before) markSeen(post.id);
	app.setHasNewUpdates(!!before && before !== String(post.id));
}

function postDate(value) {
	const d = new Date(String(value || '').replace(' ', 'T'));
	return isNaN(d) ? String(value || '') : dayLabel(d, { month: 'long', day: 'numeric', year: 'numeric' });
}

export function mount(container, { app, params }) {
	const inner = h('div', { class: 'content-inner narrow' });
	const list = h('div', { class: 'stack' });
	const more = h('div', { style: { padding: '16px 0', textAlign: 'center' } });
	replace(container, inner);
	replace(inner, h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Updates'), h('div', { class: 'sub' }, 'What’s new on Empanadas.io.'))), list, more);

	const before = seen();
	let page = 0;
	let total = null;
	let loading = false;
	let newestMarked = false;
	// Posts are new until the one the player last saw.
	let reachedSeen = !before;

	function card(post) {
		const author = post.author || {};
		return h('article', { class: 'card post' + (post.isNew ? ' new' : '') },
			h('div', { class: 'row-flex', style: { marginBottom: '4px' } },
				h('h2', null, post.title || 'Update'),
				post.isNew ? h('span', { class: 'badge accent' }, 'New') : null),
			h('div', { class: 'byline' }, avatar(author.pfp, 'sm'), h('span', null, author.username || 'Empanadas.io'), h('span', null, '·'), h('span', null, postDate(post.date)),
				post.edited ? h('span', null, '(edited)') : null),
			sanitize(post.content));
	}

	async function next() {
		if (loading || (total !== null && page >= total)) return;
		loading = true;
		replace(more, h('span', { class: 'spinner', style: { display: 'inline-block' } }));
		const result = await window.native.data.load('announcement', params && params.id && page === 0 ? { id: params.id } : { page });
		loading = false;
		if (!result.ok || !result.data || !result.data.found) {
			if (!result.ok) {
				replace(more, h('div', { class: 'banner error' }, icon('alert'), result.error.message,
					h('div', { class: 'actions' }, button('Try Again', next, { kind: 'small' }))));
			} else {
				replace(more, page === 0 ? h('div', { class: 'empty-state' }, 'No updates yet.') : h('div', { class: 'muted small' }, 'That’s everything.'));
				total = page;
			}
			return;
		}
		const post = result.data;
		total = Number(post.total) || total;
		page = (Number(post.page) || page) + 1;
		if (!newestMarked) {
			newestMarked = true;
			if (Number(post.page) === 0) {
				markSeen(post.id);
				app.setHasNewUpdates(false);
			}
		}
		if (String(post.id) === before) reachedSeen = true;
		post.isNew = !reachedSeen;
		list.appendChild(card(post));
		replace(more, total !== null && page >= total ? h('div', { class: 'muted small' }, 'That’s everything.') : button('Show Older', next, { kind: 'small' }));
	}

	const observer = new IntersectionObserver((entries) => {
		if (entries.some((e) => e.isIntersecting)) next();
	}, { root: container, rootMargin: '400px' });
	observer.observe(more);
	next();

	return {
		title: 'Updates',
		refresh() {
			replace(list);
			page = 0;
			total = null;
			reachedSeen = !before;
			next();
		},
		destroy() { observer.disconnect(); }
	};
}
