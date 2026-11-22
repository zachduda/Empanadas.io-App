// A player's profile, from /v2/app/profile.php: the player's own (My
// Profile) without an id, anyone's with one, under the site's rules (a
// friends-only profile shows a stranger only the name and picture).

import { h, replace, button, icon, avatar } from '../dom.js';
import { num, plural, dayLabel } from '../format.js';
import { load, staleBanner, errorState, skeleton } from '../data.js';
import { badges, presenceOf, playerRow, xpBreakdown } from '../components.js';
import { relationButtons } from '../friendship.js';

// Someone else's profile, kept for the session: opening it again shows it at
// once and only asks the site again if it is over a minute old.
const recent = new Map();

export function mount(container, { app, params }) {
	const id = params && params.id ? String(params.id).toLowerCase() : null;
	const inner = h('div', { class: 'content-inner' });
	replace(container, inner);
	let last = null;
	let editing = false;

	function stat(k, v) {
		return h('div', { class: 'stat' }, h('div', { class: 'k' }, k), h('div', { class: 'v', title: num(v) }, num(v)));
	}

	function bioEditor(p) {
		const field = h('input', { class: 'field', type: 'text', maxlength: '200', value: p.bio || '', placeholder: 'Say something about yourself', spellcheck: 'true' });
		const save = button('Save', async () => {
			save.disabled = true;
			const result = await window.native.data.act('updateBio', { text: field.value });
			save.disabled = false;
			if (!result.ok) {
				app.toast(result.error.message, 'error');
				return;
			}
			editing = false;
			app.toast('Status updated.', 'success');
			refresh();
		}, { kind: 'primary small' });
		field.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') save.click();
			if (e.key === 'Escape') { editing = false; draw(); }
		});
		setTimeout(() => field.focus(), 0);
		return h('div', { class: 'row-flex', style: { marginTop: '8px' } }, field, save, button('Cancel', () => { editing = false; draw(); }, { kind: 'small' }));
	}

	function draw() {
		const result = last;
		if (!result) {
			replace(inner, skeleton(4, 24));
			return;
		}
		if (!result.data) {
			replace(inner, errorState(result, refresh));
			return;
		}
		const d = result.data;
		const p = d.profile || {};
		const rel = d.relationship || { state: p.is_self ? 'self' : 'none' };
		const self = rel.state === 'self' || p.is_self;
		const xp = d.xp;
		const stats = d.stats;
		const friends = d.friends;
		app.setTitle(self ? 'My Profile' : p.username);

		const actions = self
			? [button('Change Picture', () => window.native.site.open('picture'), { kind: 'small' }),
				button('Edit Status', () => { editing = true; draw(); }, { kind: 'small', icon: 'pencil' })]
			: relationButtons(app, { id: p.id, username: p.username, relation: rel.state, acceptsRequests: rel.accepts_requests !== false }, () => {
				recent.clear();
				refresh();
			});

		const presence = p.presence && p.presence.state ? presenceOf(p.presence.state) : null;
		const head = h('div', { class: 'card', style: { marginBottom: '16px' } },
			h('div', { class: 'profile-head' },
				avatar(p.pfp, 'lg', presence),
				h('div', { class: 'who' },
					h('h1', null, p.username || 'Player', badges(p)),
					editing && self ? bioEditor(p) : (p.bio ? h('div', { class: 'bio selectable' }, p.bio) : (self ? h('div', { class: 'bio muted' }, 'No status yet.') : null)),
					h('div', { class: 'facts' },
						p.presence && p.presence.label ? h('span', null, p.presence.label) : null,
						p.member_since ? h('span', null, 'Joined ' + dayLabel(p.member_since, { month: 'long', year: 'numeric' })) : null,
						p.days !== null && p.days !== undefined ? h('span', null, plural(p.days, 'day') + ' on Empanadas.io') : null,
						p.private && !self ? h('span', null, 'This profile is private.') : null)),
				h('div', { class: 'actions' }, actions)));

		const blocks = [];
		if (xp) {
			blocks.push(h('div', { class: 'card' },
				h('div', { class: 'card-title' }, 'Experience', h('span', { class: 'aside' }, num(xp.total) + ' XP')),
				h('div', { class: 'xp-rank', style: { marginBottom: '14px' } },
					h('div', { class: 'xp-icon' }, xp.icon || '⭐'),
					h('div', { style: { flex: '1' } },
						h('div', { style: { fontWeight: '700', fontSize: '15px' } }, xp.rank),
						h('div', { class: 'muted small' }, xp.next_rank && xp.next ? num(Math.max(0, xp.next - xp.total)) + ' XP to ' + xp.next_rank : 'Top rank'),
						h('div', { class: 'meter gold', style: { marginTop: '8px' } }, h('span', { style: { width: Math.min(100, Number(xp.progress) || 0) + '%' } })))),
				Array.isArray(xp.breakdown) && xp.breakdown.length ? xpBreakdown(xp.breakdown) : null));
		}
		if (stats) {
			const cells = [];
			if (stats.spin) cells.push(stat('Lifetime Spins', stats.spin.lifetime), stat('Spins Now', stats.spin.current), stat('Prestige', stats.spin.prestige), stat('Ascensions', stats.spin.ascends));
			if (stats.flappy) cells.push(stat('Flappy Best', stats.flappy.high), stat('Flappy Rounds', stats.flappy.played));
			if (stats.tower) cells.push(stat('Tower Best', stats.tower.high), stat('Tower Rounds', stats.tower.played), stat('Best Streak', stats.tower.best_streak), stat('Perfect Drops', stats.tower.perfects));
			if (stats.peppers) cells.push(stat('Peppers', stats.peppers.current), stat('Peppers Earned', stats.peppers.lifetime));
			if (stats.pumpkin_season || stats.pumpkins) cells.push(stat('Pumpkins', stats.pumpkins));
			blocks.push(h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Stats'), h('div', { class: 'stat-grid' }, cells)));
		}
		if (p.star_sign && p.star_sign.name) {
			blocks.push(h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Star Sign'),
				h('div', { class: 'sign' }, h('div', { class: 'symbol' }, p.star_sign.symbol || '✨'),
					h('div', null, h('div', { style: { fontWeight: '700' } }, p.star_sign.name), h('div', { class: 'muted small selectable' }, p.star_sign.blurb || '')))));
		}
		if (friends && Array.isArray(friends.list)) {
			const list = friends.list.filter((f) => f.relation === 'friends' || !self);
			blocks.push(h('div', { class: 'card flush' },
				h('div', { class: 'card-title', style: { padding: '16px 16px 4px' } }, 'Friends', h('span', { class: 'aside' }, num(friends.total))),
				list.length ? h('div', { class: 'list' }, list.slice(0, 50).map((f) => playerRow(f, {
					subtitle: f.is_you ? 'You' : (f.label || null),
					onOpen: f.is_you ? () => app.navigate({ screen: 'profile' }) : () => app.navigate({ screen: 'profile', id: f.id })
				}))) : h('div', { class: 'list-empty' }, self ? 'No friends yet.' : 'No friends to show.')));
		}

		replace(inner, staleBanner(result, refresh), head,
			blocks.length ? h('div', { class: 'grid two' }, blocks) : (p.private ? h('div', { class: 'empty-state' }, icon('shield'), h('h2', null, 'Private profile'), h('p', null, 'Only their friends can see more.')) : null));
	}

	function render(result) {
		if (!result || (!result.data && last && last.data)) return;
		last = result;
		if (id && result.ok && result.data) recent.set(id, { result, at: Date.now() });
		draw();
	}

	function refresh() {
		return load('profile', id ? { id } : {}, render, { cached: false });
	}

	const kept = id ? recent.get(id) : null;
	if (kept) {
		last = kept.result;
		draw();
		if (Date.now() - kept.at > 60 * 1000) refresh();
	} else {
		draw();
		load('profile', id ? { id } : {}, render);
	}

	return { title: id ? 'Profile' : 'My Profile', refresh };
}

export function forgetProfiles() {
	recent.clear();
}
