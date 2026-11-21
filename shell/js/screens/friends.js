// Friends: Find Friends (search as you type, /v2/ios/search.php), then the
// requests to answer, the ones sent, and the friends themselves, online
// first - all from the player's own profile.

import { h, replace, icon } from '../dom.js';
import { num } from '../format.js';
import { load, staleBanner, errorState, skeleton } from '../data.js';
import { playerRow, badges } from '../components.js';
import { relationButtons } from '../friendship.js';
import { forgetProfiles } from './profile.js';

const RELATION_LABEL = {
	self: 'You',
	friends: 'Friends',
	outgoing: 'Request sent',
	incoming: 'Wants to be your friend',
	none: null
};

export function mount(container, { app, params }) {
	const inner = h('div', { class: 'content-inner narrow' });
	replace(container, inner);

	const field = h('input', { class: 'field', type: 'search', placeholder: 'Find friends by username', 'aria-label': 'Find friends', spellcheck: 'false', autocomplete: 'off', maxlength: '16' });
	const results = h('div');
	const mine = h('div');
	replace(inner,
		h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Friends'), h('div', { class: 'sub' }, 'Add friends to see when they’re online and how they’re doing.'))),
		h('div', { class: 'search-field', style: { marginBottom: '16px' } }, icon('search'), field),
		results,
		mine);

	let searchSeq = 0;
	let searchTimer = null;
	let page = 0;
	let query = '';
	let found = [];
	let hasMore = false;
	let own = null;

	async function search(more = false) {
		const seq = ++searchSeq;
		const q = field.value.trim();
		if (q.length < 2) {
			query = '';
			found = [];
			drawResults();
			return;
		}
		page = more ? page + 1 : 0;
		if (!more) replace(results, h('div', { class: 'card', style: { marginBottom: '16px' } }, skeleton(3, 30)));
		const result = await window.native.data.load('search', { q, page });
		if (seq !== searchSeq) return;
		if (!result.ok) {
			replace(results, h('div', { class: 'banner error' }, icon('alert'), result.error.message));
			return;
		}
		query = q;
		const rows = Array.isArray(result.data.results) ? result.data.results : [];
		found = more ? found.concat(rows) : rows;
		hasMore = !!result.data.has_more;
		drawResults();
	}

	function drawResults() {
		if (!query) {
			replace(results);
			return;
		}
		replace(results, h('div', { class: 'card flush', style: { marginBottom: '20px' } },
			h('div', { class: 'card-title', style: { padding: '14px 16px 4px' } }, 'Results for “' + query + '”'),
			found.length ? h('div', { class: 'list' }, found.map((p) => playerRow(p, {
				subtitle: p.private && p.relation !== 'friends' ? 'Private profile' : RELATION_LABEL[p.relation] || null,
				trail: [badges(p), relationButtons(app, { id: p.id, username: p.username, relation: p.relation, acceptsRequests: p.accepts_requests !== false }, () => {
					forgetProfiles();
					search();
					loadOwn();
				})],
				onOpen: p.relation === 'self' ? () => app.navigate({ screen: 'profile' }) : () => app.navigate({ screen: 'profile', id: p.id })
			}))) : h('div', { class: 'list-empty' }, 'Nobody by that name.'),
			hasMore ? h('div', { style: { padding: '10px 16px' } }, h('button', { type: 'button', class: 'btn small', onclick: () => search(true) }, 'Show More')) : null));
	}

	function section(title, rows, empty) {
		return h('div', { class: 'card flush', style: { marginBottom: '16px' } },
			h('div', { class: 'card-title', style: { padding: '14px 16px 4px' } }, title, h('span', { class: 'aside' }, num(rows.length))),
			rows.length ? h('div', { class: 'list' }, rows) : h('div', { class: 'list-empty' }, empty));
	}

	function drawOwn(result) {
		if (!result) return;
		if (!result.data) {
			if (!own) replace(mine, errorState(result, loadOwn));
			return;
		}
		own = result;
		const list = (result.data.friends && Array.isArray(result.data.friends.list)) ? result.data.friends.list : [];
		const after = () => { forgetProfiles(); loadOwn(); };
		const row = (f) => playerRow(f, {
			subtitle: f.label || null,
			trail: relationButtons(app, { id: f.id, username: f.username, relation: f.relation }, after),
			onOpen: () => app.navigate({ screen: 'profile', id: f.id })
		});
		const incoming = list.filter((f) => f.relation === 'incoming');
		const outgoing = list.filter((f) => f.relation === 'outgoing');
		const order = { online: 0, away: 1, recent: 1 };
		const friends = list.filter((f) => f.relation === 'friends')
			.sort((a, b) => (order[a.state] ?? 2) - (order[b.state] ?? 2) || String(a.username).localeCompare(String(b.username)));
		app.setPendingFriends(incoming.length);
		replace(mine,
			staleBanner(result, loadOwn),
			incoming.length ? section('Friend Requests', incoming.map(row), '') : null,
			section('Your Friends', friends.map((f) => playerRow(f, {
				subtitle: f.label || null,
				onOpen: () => app.navigate({ screen: 'profile', id: f.id })
			})), 'No friends yet. Search for someone above.'),
			outgoing.length ? section('Requests You Sent', outgoing.map(row), '') : null);
	}

	function loadOwn() {
		return load('profile', {}, drawOwn, { cached: !own });
	}

	field.addEventListener('input', () => {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => search(), 250);
	});
	field.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && field.value) {
			e.stopPropagation();
			field.value = '';
			search();
		}
	});

	replace(mine, skeleton(5, 34));
	loadOwn();
	if (params && params.search) setTimeout(() => field.focus(), 0);

	return {
		title: 'Friends',
		refresh() {
			forgetProfiles();
			if (query) search();
			return loadOwn();
		},
		focusSearch() { field.focus(); field.select(); },
		destroy() { clearTimeout(searchTimer); }
	};
}
