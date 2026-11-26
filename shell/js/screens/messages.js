// Messages: the inbox beside the conversation open in it, from the site's
// /v2/app/messages.php (the conversations and messages screens' data in
// main.js). Friends only, as the site decides. An open conversation asks for
// what's new every few seconds; the inbox every twenty. Everything a player
// wrote goes on the page as text.
//
// { screen: 'messages' } opens the inbox, { screen: 'messages', id } the
// conversation with that player (a profile's Message button,
// empanadas-io://messages/<id>, a notification).

import { h, replace, icon, iconButton, avatar, button } from '../dom.js';
import { ago } from '../format.js';
import { load, errorState, skeleton } from '../data.js';
import { presenceOf } from '../components.js';
import { forgetProfiles } from './profile.js';

const THREAD_POLL = 4000;
const INBOX_POLL = 20000;
// A gap this long between two messages gets the time written between them.
const GAP = 15 * 60;

const REPORT_REASONS = [
	{ id: 'spam', label: 'Spam' },
	{ id: 'harassment', label: 'Harassment or Bullying' },
	{ id: 'inappropriate', label: 'Inappropriate Content' },
	{ id: 'other', label: 'Something Else' }
];

// Why the box isn't there, in the site's reasons.
function reasonText(reason, name) {
	const who = name || 'them';
	switch (reason) {
	case 'not_friends': return 'You can only message friends. Add ' + who + ' as a friend to message them.';
	case 'blocked': return 'You blocked ' + who + '. Unblock them to send a message.';
	case 'unavailable': return "You can't message " + who + ' right now.';
	case 'unverified': return 'Verify your email address to send messages.';
	default: return "You can't message " + who + '.';
	}
}

// A player's id however it came (dashed or not, any case), for comparing.
function key(id) {
	return String(id || '').toLowerCase().replace(/-/g, '');
}

function nonce() {
	return crypto.randomUUID().replace(/-/g, '');
}

function stamp(seconds) {
	return seconds ? new Date(seconds * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
}

function shortStamp(seconds) {
	if (!seconds) return '';
	const d = new Date(seconds * 1000);
	const now = new Date();
	if (now - d < 60 * 60 * 1000) return ago(d.getTime());
	if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
	if (now - d < 6 * 86400 * 1000) return d.toLocaleDateString(undefined, { weekday: 'short' });
	return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function mount(container, { app, params }) {
	const list = h('div', { class: 'dm-list', role: 'list' });
	const side = h('aside', { class: 'dm-side', 'aria-label': 'Conversations' },
		h('div', { class: 'dm-side-head' },
			h('h1', null, 'Messages'),
			iconButton('pencil', 'New Message', () => startPicking())),
		list);
	const main = h('section', { class: 'dm-main', 'aria-live': 'polite' });
	const root = h('div', { class: 'dm' }, side, main);
	replace(container, root);

	let inbox = null;
	let inboxError = null;
	let picking = null;
	let current = null;
	let threadTimer = null;
	let destroyed = false;

	// --- The inbox ----------------------------------------------------------

	function renderInbox(result) {
		if (destroyed || !result) return;
		if (result.data) {
			inbox = result.data;
			inboxError = result.ok ? null : result;
			if (Number.isInteger(inbox.unread)) app.setUnreadMessages(inbox.unread);
		} else if (!inbox) {
			inboxError = result;
		}
		if (!picking) drawInbox();
	}

	function loadInbox(cached = false) {
		return load('conversations', {}, renderInbox, { cached });
	}

	function drawInbox() {
		if (!inbox) {
			replace(list, inboxError ? errorState(inboxError, () => loadInbox()) : skeleton(6, 40));
			return;
		}
		const conversations = Array.isArray(inbox.conversations) ? inbox.conversations : [];
		const blocked = Array.isArray(inbox.blocked) ? inbox.blocked : [];
		const rows = conversations.map((c) => {
			const p = c.with || {};
			const row = h('button', {
				type: 'button',
				role: 'listitem',
				class: 'dm-conv' + (current && current.id === key(p.id) ? ' active' : '') + (c.unread ? ' unread' : '')
			},
			avatar(p.pfp, 'md', p.state ? presenceOf(p.state) : null),
			h('div', { class: 'main' },
				h('div', { class: 'top' },
					h('span', { class: 'name' }, p.username || 'Player'),
					h('span', { class: 'when', title: stamp(c.last && c.last.sent) }, shortStamp(c.last && c.last.sent))),
				h('div', { class: 'preview' }, (c.last && c.last.from_me ? 'You: ' : '') + ((c.last && c.last.preview) || ''))),
			c.unread ? h('span', { class: 'count', 'aria-label': c.unread + ' unread' }, String(c.unread)) : null);
			row.addEventListener('click', () => open(p.id, p));
			return row;
		});
		replace(list,
			inboxError ? h('div', { class: 'banner warn small' }, icon(inboxError.error && inboxError.error.code === 'network' ? 'offline' : 'alert'),
				h('span', null, "Couldn't check for new messages.")) : null,
			rows.length ? rows : h('div', { class: 'list-empty' },
				h('p', null, 'No messages yet.'),
				button('Message a Friend', () => startPicking(), { kind: 'primary small', icon: 'pencil' })),
			blocked.length ? h('div', { class: 'dm-section' }, 'Blocked') : null,
			blocked.map((p) => h('div', { class: 'dm-conv blocked', role: 'listitem' },
				avatar(p.pfp, 'md'),
				h('div', { class: 'main' }, h('div', { class: 'name' }, p.username || 'Player')),
				button('Unblock', (e) => setBlocked(p, false, e.currentTarget), { kind: 'small' }))));
	}

	// --- New message: one of your friends ---------------------------------------

	async function startPicking() {
		const field = h('input', { class: 'field', type: 'search', placeholder: 'Search your friends', 'aria-label': 'Search your friends', spellcheck: 'false', autocomplete: 'off' });
		const results = h('div', null, skeleton(4, 36));
		picking = { friends: null, field, results };
		replace(list, h('div', { class: 'dm-picker' },
			h('div', { class: 'search-field' }, icon('search'), field),
			button('Cancel', () => stopPicking(), { kind: 'quiet small' })), results);
		field.addEventListener('input', drawFriends);
		field.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') { e.stopPropagation(); stopPicking(); }
		});
		field.focus();
		await load('profile', {}, (result) => {
			if (!picking || !result || !result.data) {
				if (picking && result && !result.data) replace(results, errorState(result, () => startPicking()));
				return;
			}
			const all = result.data.friends && Array.isArray(result.data.friends.list) ? result.data.friends.list : [];
			picking.friends = all.filter((f) => f.relation === 'friends')
				.sort((a, b) => String(a.username).localeCompare(String(b.username)));
			drawFriends();
		});
	}

	function drawFriends() {
		if (!picking || !picking.friends) return;
		const q = picking.field.value.trim().toLowerCase();
		const shown = picking.friends.filter((f) => !q || String(f.username).toLowerCase().includes(q));
		if (!picking.friends.length) {
			replace(picking.results, h('div', { class: 'list-empty' },
				h('p', null, 'Once you have friends, you can message them here.'),
				button('Find Friends', () => app.navigate({ screen: 'friends', search: true }), { kind: 'primary small', icon: 'search' })));
			return;
		}
		replace(picking.results, shown.length ? shown.map((f) => {
			const row = h('button', { type: 'button', class: 'dm-conv' },
				avatar(f.pfp, 'md', f.state ? presenceOf(f.state) : null),
				h('div', { class: 'main' }, h('div', { class: 'name' }, f.username), f.label ? h('div', { class: 'preview' }, f.label) : null));
			row.addEventListener('click', () => { stopPicking(); open(f.id, f); });
			return row;
		}) : h('div', { class: 'list-empty' }, 'No friends by that name.'));
	}

	function stopPicking() {
		picking = null;
		drawInbox();
	}

	// --- A conversation -------------------------------------------------------

	function placeholder() {
		replace(main, h('div', { class: 'empty-state dm-empty' },
			icon('message'),
			h('h2', null, 'Your Messages'),
			h('p', null, 'Pick a conversation, or start one with a friend.'),
			h('div', { class: 'actions' }, button('New Message', () => startPicking(), { kind: 'primary', icon: 'pencil' }))));
	}

	async function open(id, preview) {
		stopThreadPoll();
		const convo = {
			id: key(id), raw: String(id), with: preview || null, messages: [], pending: [], hasMore: false, seenUpTo: 0,
			canMessage: false, reason: null, blocked: false, loaded: false, error: null
		};
		current = convo;
		const head = h('header', { class: 'dm-head' });
		const scroller = h('div', { class: 'dm-scroll selectable' });
		const footer = h('div', { class: 'dm-foot' });
		Object.assign(convo, { head, scroller, footer, footerMode: null, field: null });
		replace(main, head, scroller, footer);
		drawThread(true);
		if (!picking) drawInbox();

		const result = await window.native.data.load('messages', { id: convo.raw });
		if (destroyed || current !== convo) return;
		if (!result.ok) {
			convo.error = result;
			replace(main, errorState(result, () => open(id, preview)));
			return;
		}
		convo.loaded = true;
		apply(result.data, false);
		drawThread(true);
		markRead();
		startThreadPoll();
		if (convo.field) convo.field.focus();
	}

	function apply(data, appendOnly) {
		current.with = data.with || current.with;
		current.canMessage = !!data.can_message;
		current.reason = data.reason || null;
		current.blocked = !!data.blocked;
		current.seenUpTo = Number(data.seen_up_to) || 0;
		const incoming = Array.isArray(data.messages) ? data.messages : [];
		if (appendOnly) {
			const have = new Set(current.messages.map((m) => m.id));
			for (const m of incoming) if (!have.has(m.id)) current.messages.push(m);
		} else {
			current.messages = incoming;
			current.hasMore = !!data.has_more;
		}
	}

	function drawThread(toEnd) {
		drawHead();
		drawFooter();
		drawMessages(toEnd);
	}

	function drawHead() {
		const p = current.with || {};
		const openProfile = () => app.navigate({ screen: 'profile', id: p.id || current.raw });
		const who = h('button', { type: 'button', class: 'dm-who', title: 'View profile' },
			p.pfp ? avatar(p.pfp, null, p.state ? presenceOf(p.state) : null) : null,
			h('div', { class: 'main' },
				h('div', { class: 'name' }, p.username || '…'),
				p.label ? h('div', { class: 'sub' }, p.label) : null));
		who.addEventListener('click', openProfile);
		const more = current.loaded ? iconButton('more', 'More', () => app.contextMenu([
			{ id: 'profile', label: 'View Profile' },
			{ type: 'separator' },
			{ id: 'block', label: current.blocked ? 'Unblock ' + p.username : 'Block ' + p.username + '…' }
		], (choice) => {
			if (choice === 'profile') openProfile();
			if (choice === 'block') setBlocked(current.with, !current.blocked);
		})) : null;
		replace(current.head, who, h('div', { class: 'spacer' }), more);
	}

	function drawMessages(toEnd) {
		const box = current.scroller;
		const nearEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
		const kept = box.scrollTop;
		const rows = [];
		if (current.hasMore) rows.push(h('div', { class: 'dm-older' }, button('Load Earlier Messages', loadOlder, { kind: 'small' })));
		let previous = null;
		const all = current.messages.concat(current.pending);
		for (const m of all) {
			if (!previous || (m.sent && previous.sent && m.sent - previous.sent > GAP)) {
				rows.push(h('div', { class: 'dm-gap' }, stamp(m.sent)));
			}
			const bubble = h('div', { class: 'dm-bubble', title: stamp(m.sent) }, m.text);
			const row = h('div', { class: 'dm-row' + (m.from_me ? ' me' : '') + (m.state ? ' ' + m.state : '') }, bubble,
				!m.from_me && m.id ? iconButton('more', 'Message options', () => messageMenu(m), { class: 'dm-more' }) : null);
			row.addEventListener('contextmenu', (e) => { e.preventDefault(); messageMenu(m); });
			rows.push(row);
			if (m.state === 'failed') {
				const retryButton = h('button', { type: 'button', class: 'link' }, 'Try Again');
				retryButton.addEventListener('click', () => retry(m));
				rows.push(h('div', { class: 'dm-status error' }, (m.error || 'Not sent.') + ' ', retryButton));
			}
			previous = m;
		}
		const newest = current.messages[current.messages.length - 1];
		if (newest && newest.from_me && current.seenUpTo >= newest.id && !current.pending.length) {
			rows.push(h('div', { class: 'dm-status' }, 'Seen'));
		}
		if (!all.length && current.loaded) {
			rows.push(h('div', { class: 'dm-hello muted' }, current.canMessage ? 'Say hi to ' + (current.with && current.with.username) + '!' : 'No messages yet.'));
		}
		replace(box, rows);
		box.scrollTop = (toEnd || nearEnd) ? box.scrollHeight : kept;
	}

	function drawFooter() {
		const mode = !current.loaded ? 'loading' : current.canMessage ? 'compose' : 'notice:' + current.reason;
		if (mode === current.footerMode) return;
		current.footerMode = mode;
		current.field = null;
		if (mode === 'loading') {
			replace(current.footer);
			return;
		}
		if (!current.canMessage) {
			replace(current.footer, h('div', { class: 'dm-notice' }, reasonText(current.reason, current.with && current.with.username)));
			return;
		}
		const limit = Number(inbox && inbox.max_length) || 1000;
		const field = h('textarea', { class: 'field dm-field', rows: '1', placeholder: 'Message ' + current.with.username, 'aria-label': 'Message ' + current.with.username, spellcheck: 'true' });
		const count = h('span', { class: 'dm-count', 'aria-live': 'polite' });
		const send = iconButton('send', 'Send', () => sendNow(), { class: 'dm-send' });
		const sync = () => {
			const box = current.scroller;
			const atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
			field.style.height = 'auto';
			field.style.height = Math.min(160, field.scrollHeight + 2) + 'px';
			if (atEnd) box.scrollTop = box.scrollHeight;
			const left = limit - field.value.trim().length;
			count.textContent = left < 100 ? String(left) : '';
			count.classList.toggle('over', left < 0);
			send.disabled = !field.value.trim() || left < 0;
		};
		field.addEventListener('input', sync);
		// Return sends, Shift+Return is a new line; not while an input method is composing.
		field.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendNow(); }
		});
		current.field = field;
		current.sync = sync;
		current.limit = limit;
		replace(current.footer, h('div', { class: 'dm-compose' }, field, count, send));
		sync();
	}

	function sendNow() {
		const field = current && current.field;
		if (!field) return;
		const text = field.value.trim();
		if (!text || text.length > current.limit) return;
		field.value = '';
		current.sync();
		const pending = { id: 0, nonce: nonce(), from_me: true, text, sent: Math.floor(Date.now() / 1000), state: 'pending' };
		current.pending.push(pending);
		drawMessages(true);
		field.focus();
		deliver(pending);
	}

	async function deliver(pending) {
		const convo = current;
		const result = await window.native.data.act('sendMessage', { id: convo.raw, text: pending.text, nonce: pending.nonce });
		if (destroyed) return;
		if (result.ok && result.data && result.data.message) {
			convo.pending = convo.pending.filter((m) => m !== pending);
			if (!convo.messages.some((m) => m.id === result.data.message.id)) convo.messages.push(result.data.message);
			convo.messages.sort((a, b) => a.id - b.id);
		} else {
			const error = (result && result.error) || {};
			pending.state = 'failed';
			pending.error = error.code === 'network' ? "Couldn't reach Empanadas.io." : (error.message || 'Not sent.');
			if (['not_friends', 'blocked', 'unavailable', 'unverified'].includes(error.code)) {
				convo.canMessage = false;
				convo.reason = error.code;
			}
		}
		if (current === convo) drawThread(true);
		loadInbox();
	}

	function retry(m) {
		m.state = 'pending';
		drawMessages(true);
		deliver(m);
	}

	async function loadOlder(e) {
		const btn = e.currentTarget;
		btn.disabled = true;
		const convo = current;
		const first = convo.messages.length ? convo.messages[0].id : 0;
		const result = await window.native.data.load('messages', { id: convo.raw, before: first });
		if (destroyed || current !== convo) return;
		if (!result.ok) {
			btn.disabled = false;
			app.toast(result.error.message, 'error');
			return;
		}
		const box = convo.scroller;
		const fromEnd = box.scrollHeight - box.scrollTop;
		convo.messages = (result.data.messages || []).concat(convo.messages);
		convo.hasMore = !!result.data.has_more;
		drawMessages(false);
		box.scrollTop = box.scrollHeight - fromEnd;
	}

	async function markRead() {
		if (!current || document.hidden) return;
		const theirs = current.messages.filter((m) => !m.from_me && !m.read);
		if (!theirs.length) return;
		const convo = current;
		const result = await window.native.data.act('readMessages', { id: convo.raw, upTo: theirs[theirs.length - 1].id });
		if (destroyed || !result.ok) return;
		for (const m of theirs) m.read = true;
		const row = inbox && Array.isArray(inbox.conversations) && inbox.conversations.find((c) => key(c.with && c.with.id) === convo.id);
		if (row) row.unread = 0;
		if (inbox && Number.isInteger(result.data && result.data.unread)) inbox.unread = result.data.unread;
		if (!picking) drawInbox();
	}

	async function poll() {
		if (destroyed || !current || !current.loaded || document.hidden) return;
		const convo = current;
		const last = convo.messages.length ? convo.messages[convo.messages.length - 1].id : 0;
		const result = await window.native.data.load('messages', { id: convo.raw, after: last });
		if (destroyed || current !== convo || !result.ok) return;
		const before = [convo.messages.length, convo.seenUpTo, convo.canMessage, convo.blocked, convo.with && convo.with.label];
		apply(result.data, true);
		const after = [convo.messages.length, convo.seenUpTo, convo.canMessage, convo.blocked, convo.with && convo.with.label];
		if (before.some((v, i) => v !== after[i])) {
			drawThread(false);
			markRead();
		}
	}

	function startThreadPoll() {
		stopThreadPoll();
		threadTimer = setInterval(poll, THREAD_POLL);
	}

	function stopThreadPoll() {
		clearInterval(threadTimer);
		threadTimer = null;
	}

	// --- Copy, report and block -----------------------------------------------

	function messageMenu(m) {
		const items = [{ id: 'copy', label: 'Copy' }];
		if (!m.from_me && m.id) {
			items.push({ type: 'separator' });
			for (const r of REPORT_REASONS) items.push({ id: 'report:' + r.id, label: 'Report as ' + r.label + '…' });
		}
		app.contextMenu(items, (choice) => {
			if (choice === 'copy') {
				navigator.clipboard.writeText(m.text).then(() => app.toast('Copied.', 'success')).catch(() => {});
			} else if (String(choice).startsWith('report:')) {
				report(m, String(choice).slice(7));
			}
		});
	}

	async function report(m, reason) {
		const name = (current && current.with && current.with.username) || 'They';
		const note = await app.confirm({
			title: 'Report this message?',
			message: "We'll take a look. " + name + " won't know who reported it.",
			confirm: 'Report',
			danger: true,
			input: { placeholder: 'Anything to add? (optional)' }
		});
		if (note === null) return;
		const result = await window.native.data.act('reportMessage', { message: m.id, reason, note });
		if (!result.ok) {
			app.toast(result.error.message, 'error');
			return;
		}
		app.toast('Thanks for telling us. We’ll take a look.', 'success');
		if (current && current.with && !current.blocked) {
			const block = await app.confirm({ title: 'Block ' + current.with.username + ' too?', message: "You won't be able to message each other, and you'll no longer be friends.", confirm: 'Block', cancel: 'Not Now', danger: true });
			if (block) setBlocked(current.with, true, null, true);
		}
	}

	async function setBlocked(person, block, btn = null, sure = false) {
		if (!person) return;
		if (block && !sure) {
			const ok = await app.confirm({
				title: 'Block ' + person.username + '?',
				message: "You won't be able to message each other or send friend requests, and you'll no longer be friends. They won't be told.",
				confirm: 'Block',
				danger: true
			});
			if (!ok) return;
		}
		if (btn) btn.disabled = true;
		const result = await window.native.data.act('blockPlayer', { id: person.id, block });
		if (btn) btn.disabled = false;
		if (!result.ok) {
			app.toast(result.error.message, 'error');
			return;
		}
		app.toast(person.username + (block ? ' is blocked.' : ' is unblocked.'), 'success');
		// A block unfriends them: profiles kept for the session are out of date.
		forgetProfiles();
		await loadInbox();
		if (current && current.id === key(person.id)) open(current.raw, current.with);
	}

	// --- Start -----------------------------------------------------------------

	const onVisible = () => { if (!document.hidden) { poll(); loadInbox(); } };
	document.addEventListener('visibilitychange', onVisible);
	const inboxTimer = setInterval(() => { if (!document.hidden) loadInbox(); }, INBOX_POLL);
	// The main process's own check (every minute, for the badge) lands here too.
	const offConversations = app.on('conversations', (result) => { if (result && result.ok && !picking) renderInbox(result); });

	drawInbox();
	loadInbox(true);
	if (params && params.id) open(params.id);
	else placeholder();

	return {
		title: 'Messages',
		refresh() {
			if (current && current.loaded) poll();
			return loadInbox();
		},
		destroy() {
			destroyed = true;
			stopThreadPoll();
			clearInterval(inboxTimer);
			document.removeEventListener('visibilitychange', onVisible);
			offConversations();
		}
	};
}
