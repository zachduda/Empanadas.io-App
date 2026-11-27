// The app's window: the sidebar, the title bar, which screen shows, and the
// app-wide events from the main process (sign-in, a game opening or
// closing, a link that opened a screen).

import { h, icon, iconButton, avatar, replace, clear, button } from './dom.js';
import { GAMES } from './format.js';
import * as welcome from './screens/welcome.js';
import * as home from './screens/home.js';
import * as games from './screens/games.js';
import * as leaderboard from './screens/leaderboard.js';
import * as friends from './screens/friends.js';
import * as profile from './screens/profile.js';
import * as settings from './screens/settings.js';
import * as updates from './screens/updates.js';
import * as feedback from './screens/feedback.js';
import * as savepoints from './screens/savepoints.js';
import * as messages from './screens/messages.js';

const native = window.native;

const SCREENS = { home, games, leaderboard, friends, messages, profile, settings, updates, feedback, savepoints };

// The sidebar: one of these is always the section a screen belongs to, in
// the Go menu's order (⌘1 to ⌘6). Your account, at the bottom, is Settings.
const SECTIONS = [
	{ screen: 'home', label: 'Home', icon: 'home' },
	{ screen: 'games', label: 'Games', icon: 'games' },
	{ screen: 'leaderboard', label: 'Leaderboards', icon: 'trophy' },
	{ screen: 'friends', label: 'Friends', icon: 'users' },
	{ screen: 'messages', label: 'Messages', icon: 'message' },
	{ screen: 'profile', label: 'My Profile', icon: 'user' }
];

// Screens that are part of another: App Settings is the app's part of
// Settings now (empanadas-io://appsettings, and older apps' App Settings…
// menu item, which these screens can be shown in).
const ALIASES = { appsettings: { screen: 'settings', section: 'app' } };

const $ = (id) => document.getElementById(id);

const state = {
	info: null,
	session: { signedIn: false },
	games: null,
	game: null,
	dashboard: null,
	route: { screen: 'home' },
	stack: [],
	current: null,
	pendingFriends: 0,
	unreadMessages: 0,
	panel: null,
	hasNewUpdates: false,
	signin: null
};

const listeners = new Map();

export const app = {
	state,

	// Opens a screen. A sidebar section starts afresh; anything else is
	// pushed on top of what is showing, and Back returns to it.
	navigate(route, { replaceTop = false } = {}) {
		if (route && ALIASES[route.screen]) route = Object.assign({}, route, ALIASES[route.screen]);
		if (!route || !SCREENS[route.screen]) return;
		if (route.screen === 'messages') {
			openMessages(route);
			return;
		}
		closeMessages();
		const isSection = SECTIONS.some((s) => s.screen === route.screen) && !route.id;
		if (isSection || route.screen === 'settings') {
			state.stack = [];
		} else if (!replaceTop) {
			state.stack.push(state.route);
		}
		show(route);
	},

	back() {
		if (state.game && !state.game.hidden) {
			native.games.close();
			return;
		}
		if (state.panel) {
			closeMessages();
			return;
		}
		const previous = state.stack.pop();
		if (previous) show(previous);
	},

	play(name) {
		return native.games.play(name).then((result) => {
			if (result && !result.ok && result.error) app.toast(result.error.message, 'error');
			return result;
		});
	},

	toast(message, kind = 'info', { timeout = 4500 } = {}) {
		const t = h('div', { class: 'toast ' + kind, role: kind === 'error' ? 'alert' : 'status' },
			icon(kind === 'error' ? 'alert' : kind === 'success' ? 'check' : 'info'), h('div', null, message));
		$('toasts').appendChild(t);
		setTimeout(() => t.remove(), timeout);
	},

	// A sheet over the window. Resolves true/false, or the typed text when
	// `input` is given.
	confirm({ title, message, confirm = 'OK', cancel = 'Cancel', danger = false, input = null }) {
		return new Promise((resolve) => {
			const root = $('modal-root');
			let field = null;
			const close = (value) => {
				document.removeEventListener('keydown', onKey, true);
				clear(root);
				resolve(value);
			};
			const ok = button(confirm, () => close(input ? field.value : true), { kind: danger ? 'danger solid' : 'primary' });
			if (input) {
				field = h('input', { class: 'field', type: 'text', placeholder: input.placeholder || '', autocomplete: 'off', spellcheck: 'false' });
				if (input.match) {
					ok.disabled = true;
					field.addEventListener('input', () => { ok.disabled = field.value !== input.match; });
				}
			}
			const onKey = (e) => {
				if (e.key === 'Escape') { e.preventDefault(); close(input ? null : false); }
				if (e.key === 'Enter' && !ok.disabled) { e.preventDefault(); ok.click(); }
			};
			document.addEventListener('keydown', onKey, true);
			const backdrop = h('div', { class: 'modal-backdrop' },
				h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
					h('h2', null, title),
					message ? h('p', null, message) : null,
					field,
					h('div', { class: 'actions' }, button(cancel, () => close(input ? null : false)), ok)));
			backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(input ? null : false); });
			replace(root, backdrop);
			(field || ok).focus();
		});
	},

	// Asks first, then signs out (the session event shows the welcome screen).
	async signOut() {
		const sure = await app.confirm({ title: 'Sign out of Empanadas.io?', message: 'Your games stay downloaded on this computer.', confirm: 'Sign Out', danger: true });
		if (sure) await native.session.signOut();
		return sure;
	},

	// A native context menu: items [{ id, label, enabled }], run(id).
	async contextMenu(items, run) {
		const id = await native.menu.popup(items);
		if (id !== null && id !== undefined) run(id);
	},

	setTitle(text) {
		state.title = text || '';
		drawTitlebar();
	},

	setPendingFriends(count) {
		state.pendingFriends = Math.max(0, Number(count) || 0);
		drawSidebar();
		drawTitlebar();
	},

	setUnreadMessages(count) {
		const n = Math.max(0, Number(count) || 0);
		if (n === state.unreadMessages) return;
		const more = n > state.unreadMessages;
		state.unreadMessages = n;
		drawSidebar();
		const badge = more && document.querySelector('.nav-item .count.unread');
		if (badge) badge.classList.add('bump');
	},

	setHasNewUpdates(value) {
		state.hasNewUpdates = !!value;
		drawTitlebar();
	},

	// Events the screens may want: 'dashboard', 'games', 'game', 'refresh'.
	on(event, fn) {
		if (!listeners.has(event)) listeners.set(event, new Set());
		listeners.get(event).add(fn);
		return () => listeners.get(event).delete(fn);
	},

	emit(event, payload) {
		for (const fn of listeners.get(event) || []) {
			try { fn(payload); } catch (err) { console.error(err); }
		}
	}
};

// --- Showing a screen -----------------------------------------------------

function show(route) {
	const content = $('content');
	if (state.current && state.current.destroy) {
		try { state.current.destroy(); } catch (err) { console.error(err); }
	}
	state.route = route;
	state.title = '';
	clear(content);
	content.scrollTop = 0;
	// Each screen eases in; restart the animation for this one.
	content.classList.remove('screen-in');
	void content.offsetWidth;
	content.classList.add('screen-in');
	const screen = SCREENS[route.screen];
	state.current = screen.mount(content, { params: route, app }) || null;
	if (state.current && state.current.title) state.title = state.current.title;
	drawSidebar();
	drawTitlebar();
	content.focus({ preventScroll: true });
}

function refreshScreen() {
	if (state.panel && state.panel.screen) {
		state.panel.screen.refresh();
		return;
	}
	if (state.current && state.current.refresh) state.current.refresh();
	else if (state.session.signedIn) show(state.route);
}

// --- Messages, in a panel over the screen ----------------------------------

function openMessages(route) {
	if (state.panel && state.panel.closing) finishClose(state.panel);
	if (state.panel) {
		if (route.id) state.panel.screen.openConversation(route.id);
		return;
	}
	const body = h('div', { class: 'dm-sheet', role: 'dialog', 'aria-label': 'Messages' });
	const layer = h('div', { class: 'dm-layer' }, body);
	layer.addEventListener('mousedown', (e) => { if (e.target === layer) closeMessages(); });
	const panel = { layer, body, screen: null, closing: false, returnFocus: document.activeElement };
	state.panel = panel;
	document.getElementById('app').appendChild(layer);
	$('content').classList.add('behind-panel');
	panel.screen = messages.mount(body, { params: route, app, onClose: () => closeMessages() });
	drawSidebar();
}

function closeMessages(instant = false) {
	const panel = state.panel;
	if (!panel || panel.closing) {
		if (panel && instant) finishClose(panel);
		return;
	}
	panel.closing = true;
	$('content').classList.remove('behind-panel');
	try { panel.screen.destroy(); } catch (err) { console.error(err); }
	drawSidebar();
	if (instant || getComputedStyle(panel.body).animationName === 'none') {
		finishClose(panel);
		return;
	}
	panel.layer.classList.add('closing');
	panel.body.addEventListener('animationend', () => finishClose(panel), { once: true });
	setTimeout(() => finishClose(panel), 400);
}

function finishClose(panel) {
	if (panel.layer.parentNode) panel.layer.remove();
	if (state.panel === panel) {
		state.panel = null;
		if (panel.returnFocus && panel.returnFocus.isConnected) panel.returnFocus.focus({ preventScroll: true });
	}
}

// --- The sidebar -----------------------------------------------------------

function sectionOf(route) {
	if (route.screen === 'profile' && !route.id) return 'profile';
	if (route.screen === 'messages') return 'messages';
	if (SECTIONS.some((s) => s.screen === route.screen)) return route.screen;
	if (route.screen === 'settings' || route.screen === 'savepoints') return 'settings';
	const below = state.stack.length ? state.stack[0] : null;
	return below ? sectionOf(below) : null;
}

// The highlight behind the current section slides from one to the next
// rather than jumping, so it is kept between redraws.
const navIndicator = h('span', { class: 'nav-indicator', 'aria-hidden': 'true' });

function drawSidebar() {
	const nav = $('sidebar');
	const current = state.panel && !state.panel.closing ? 'messages' : sectionOf(state.route);
	let active = null;
	const item = (section) => {
		const b = h('button', {
			type: 'button',
			class: 'nav-item',
			'aria-current': current === section.screen ? 'page' : null
		}, icon(section.icon), h('span', null, section.label),
		section.screen === 'friends' && state.pendingFriends ? h('span', { class: 'count', title: state.pendingFriends + ' friend requests' }, String(state.pendingFriends)) : null,
		section.screen === 'messages' && state.unreadMessages ? h('span', { class: 'count unread', title: state.unreadMessages + ' unread' }, state.unreadMessages > 99 ? '99+' : String(state.unreadMessages)) : null);
		b.addEventListener('click', () => app.navigate({ screen: section.screen }));
		if (current === section.screen) active = b;
		return b;
	};

	const account = state.dashboard && state.dashboard.account;
	const name = (account && account.username) || state.session.username || 'You';
	const who = h('button', { type: 'button', class: 'nav-account', title: 'Settings', 'aria-current': current === 'settings' ? 'page' : null },
		avatar(account && account.pfp, 'md'),
		h('span', { class: 'who' },
			h('div', { class: 'name' }, name),
			h('div', { class: 'sub' }, navigator.onLine ? 'Settings' : 'Offline')));
	who.addEventListener('click', () => app.navigate({ screen: 'settings' }));

	for (const child of [...nav.childNodes]) if (child !== navIndicator) nav.removeChild(child);
	if (!navIndicator.parentNode) nav.appendChild(navIndicator);
	for (const el of [...SECTIONS.map(item), h('div', { class: 'nav-spacer' }), who]) nav.appendChild(el);

	const previous = nav.dataset.current || '';
	nav.dataset.current = current || '';
	if (!active) {
		navIndicator.classList.remove('shown');
		return;
	}
	const place = () => {
		navIndicator.style.transform = 'translateY(' + active.offsetTop + 'px)';
		navIndicator.style.height = active.offsetHeight + 'px';
	};
	if (!navIndicator.classList.contains('shown')) {
		// First time (or back from no section): appear in place, no slide.
		navIndicator.classList.add('instant');
		place();
		void navIndicator.offsetWidth;
		navIndicator.classList.remove('instant');
		navIndicator.classList.add('shown');
	} else {
		place();
	}
	if (previous !== current) {
		active.classList.add('just-selected');
		setTimeout(() => active.classList.remove('just-selected'), 500);
	}
}

// --- The title bar ----------------------------------------------------------

function drawTitlebar() {
	const lead = $('titlebar-lead');
	const title = $('titlebar-title');
	const trail = $('titlebar-trail');
	const root = $('app');
	clear(lead);
	clear(trail);

	if (!state.session.signedIn) {
		root.classList.remove('playing');
		replace(title, '');
		return;
	}

	const g = state.game;
	if (g && !g.hidden) {
		root.classList.add('playing');
		lead.appendChild(button('Home', () => native.games.close(), { kind: 'quiet small', icon: 'back', title: 'Close the game and go back (' + (state.info && state.info.isMac ? '⌘' : 'Ctrl+') + 'W)' }));
		replace(title, g.loading ? h('span', { class: 'row-flex', style: { justifyContent: 'center' } }, h('span', { class: 'spinner' }), 'Loading ' + g.title + '…') : (GAMES[g.name] ? GAMES[g.name].full : g.title));
		trail.appendChild(iconButton(g.fullscreen ? 'exitFullscreen' : 'fullscreen', 'Full Screen', async () => {
			const fullscreen = await native.window.toggleFullscreen();
			state.game = Object.assign({}, state.game, { fullscreen });
			drawTitlebar();
		}));
		return;
	}

	root.classList.remove('playing');
	if (state.stack.length) {
		lead.appendChild(iconButton('back', 'Back', () => app.back()));
	}
	replace(title, state.title || '');

	if (g && g.hidden) {
		trail.appendChild(button('Return to ' + g.title, () => native.games.show(), { kind: 'primary small', icon: 'play' }));
	}
	const refresh = iconButton('refresh', 'Refresh', () => refreshScreen());
	trail.appendChild(refresh);
	const bell = iconButton('bell', 'Updates', () => app.navigate({ screen: 'updates' }));
	if (state.hasNewUpdates) bell.appendChild(h('span', { class: 'dot' }));
	trail.appendChild(bell);
}

// --- Signed in or out -----------------------------------------------------

function applySession(session) {
	const was = state.session.signedIn;
	state.session = Object.assign({}, state.session, session);
	const root = $('app');
	root.classList.toggle('signed-out', !state.session.signedIn);
	if (!state.session.signedIn) {
		// The last account's unsent messages aren't the next one's (screens/messages.js).
		try { localStorage.removeItem(messages.UNSENT_KEY); localStorage.removeItem(messages.DRAFTS_KEY); } catch (err) { /* nothing kept */ }
		state.stack = [];
		state.dashboard = null;
		closeMessages(true);
		if (state.current && state.current.destroy) state.current.destroy();
		state.current = welcome.mount($('content'), { app, session: state.session, signin: state.signin });
		drawTitlebar();
		return;
	}
	if (!was || !state.current || state.route.screen === 'welcome' || session.justSignedIn) {
		state.route = { screen: 'home' };
		show(state.route);
	} else {
		drawSidebar();
		drawTitlebar();
	}
}

// --- Start -------------------------------------------------------------------

async function start() {
	const root = $('app');
	state.info = await native.info();
	document.documentElement.classList.add('platform-' + state.info.platform);
	document.documentElement.style.setProperty('--titlebar', state.info.titlebar + 'px');

	native.on('session', (session) => applySession(session));
	native.on('signin', (signin) => {
		state.signin = signin;
		if (!state.session.signedIn && state.current && state.current.onSignIn) state.current.onSignIn(signin);
		if (signin && signin.state === 'failed' && state.session.signedIn) app.toast(signin.error.message, 'error');
	});
	native.on('route', (route) => {
		if (!state.session.signedIn) return;
		const r = Object.assign({}, route);
		if (r.screen === 'profile' && !r.id) delete r.id;
		app.navigate(r);
		if (r.search && state.current && state.current.focusSearch) state.current.focusSearch();
	});
	native.on('back', () => app.back());
	native.on('refresh', () => refreshScreen());
	native.on('toast', (t) => t && app.toast(t.message, t.kind || 'info'));
	native.on('data', ({ key, result }) => {
		if (key === 'dashboard' && result && result.data) {
			state.dashboard = result.data;
			app.setPendingFriends(result.data.friends && result.data.friends.pending);
			if (result.data.messages) app.setUnreadMessages(result.data.messages.unread);
		}
		if (key === 'conversations' && result && result.ok && result.data) app.setUnreadMessages(result.data.unread);
		app.emit(key, result);
	});
	native.on('games', (status) => {
		state.games = status;
		app.emit('games', status);
	});
	native.on('game', (g) => {
		state.game = g;
		drawTitlebar();
		app.emit('game', g);
	});
	native.on('background', (status) => app.emit('background', status));
	native.on('theme', (t) => app.emit('theme', t));

	window.addEventListener('online', () => { native.online(); drawSidebar(); drawTitlebar(); app.toast("You're back online.", 'success'); refreshScreen(); });
	window.addEventListener('offline', () => { drawSidebar(); drawTitlebar(); app.toast("You're offline. Games you've downloaded still work.", 'info'); });

	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && state.panel && !state.panel.closing && !$('modal-root').firstChild) {
			e.preventDefault();
			closeMessages();
			return;
		}
		if (e.key === 'Escape' && state.stack.length && !$('modal-root').firstChild && !/INPUT|TEXTAREA/.test(document.activeElement && document.activeElement.tagName)) {
			app.back();
		}
	});

	const [session, gameState, games] = await Promise.all([native.session.get(), native.games.state(), native.games.status()]);
	state.game = gameState;
	state.games = games;
	const kept = session.signedIn ? await native.data.cached('dashboard') : null;
	if (kept && kept.data) {
		state.dashboard = kept.data;
		if (kept.data.messages) state.unreadMessages = Math.max(0, Number(kept.data.messages.unread) || 0);
	}
	applySession(session);
	root.classList.remove('booting');
	root.removeAttribute('aria-busy');
	native.ready();
}

start().catch((err) => {
	console.error(err);
	replace($('content'), h('div', { class: 'empty-state' }, h('h2', null, 'Something went wrong'), h('p', null, String(err && err.message))));
});
