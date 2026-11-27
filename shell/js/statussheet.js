// Server Status: the light Settings shows, and the full status page (and the
// privacy policy and terms) in a sheet over the window, as the iOS app has them (ServerStatusViews.swift and
// StatusPageView.swift). The sheet is drawn here, its title bar and all; the
// page inside it is Statuspage's own, in a view of the app's laid over the
// sheet's body (native.status.layout()), kept apart from everything else of
// the app's (main.js, openStatusPage()).

import { h, replace, clear, button, iconButton, icon } from './dom.js';

// The site's own wording, as on iOS.
export const LEVELS = {
	checking: { title: 'Checking…', tone: 'gray', live: false },
	operational: { title: 'Server Online', tone: 'green', live: true },
	minor: { title: 'Possible Outage', tone: 'yellow', live: true },
	major: { title: 'Partial Outage', tone: 'orange', live: true },
	critical: { title: 'Website Outage', tone: 'red', live: true },
	unknown: { title: 'Unknown Status', tone: 'gray', live: false }
};

export function levelOf(name) {
	return LEVELS[name] || LEVELS.unknown;
}

// The status light: a dot in the status's colour, and while the answer is a
// live one, a ring that keeps pulsing out of it, to show it is kept up to
// date. Still under Reduce Motion (app.css).
export function statusDot(level, { size = 'small' } = {}) {
	const l = levelOf(level);
	// The ring is timed from the clock, not from when the dot was drawn, so a
	// screen drawn again (Settings is, often) never sets it off again
	// half way through one.
	return h('span', {
		class: 'status-dot ' + l.tone + (l.live ? ' live' : '') + (size === 'large' ? ' large' : ''),
		style: { animationDelay: -(Date.now() % PULSE_PERIOD) + 'ms' },
		'aria-hidden': 'true'
	});
}

let current = null;

// One ring every two seconds (app.css, @keyframes status-pulse).
const PULSE_PERIOD = 2000;

const TITLES = { status: 'Server Status', privacy: 'Privacy Policy', terms: 'Terms of Service' };

// Opens the sheet (or brings the one that is up to the front). Resolves once
// it has closed. The page is the status page, or the site's privacy policy or
// terms.
export function openStatusSheet(kind = 'status') {
	if (current) return current.closed;
	const native = window.native;
	if (!TITLES[kind]) kind = 'status';
	if (!native || !native.status) {
		// Screens newer than this app: the page in the browser instead.
		if (native && native.external) native.external.open(kind);
		return Promise.resolve();
	}
	const title = TITLES[kind];
	const noun = kind === 'status' ? 'the status page' : 'this page';

	const root = document.getElementById('modal-root');
	const returnFocus = document.activeElement;
	let state = { open: true, hasContent: false, canGoBack: false, error: null, background: null };
	let placed = false;
	let closing = false;
	let resolveClosed;
	const closed = new Promise((resolve) => { resolveClosed = resolve; });

	const back = iconButton('back', 'Back', () => native.status.back(), { class: 'status-sheet-back' });
	const browser = iconButton('external', 'Open in Browser', () => native.status.openInBrowser(kind));
	const done = button('Done', () => close(), { kind: 'primary small' });
	const placeholder = h('div', { class: 'status-sheet-placeholder' });
	const body = h('div', { class: 'status-sheet-body' }, placeholder);
	const sheet = h('div', { class: 'status-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
		h('header', { class: 'status-sheet-bar' },
			h('div', { class: 'lead' }, back),
			h('div', { class: 'title' }, title),
			h('div', { class: 'trail' }, browser, done)),
		body);
	const backdrop = h('div', { class: 'modal-backdrop status-backdrop' }, sheet);
	backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });

	function drawState() {
		back.hidden = !state.canGoBack;
		if (state.background) body.style.backgroundColor = state.background;
		const showing = state.hasContent && !state.error;
		body.classList.toggle('loaded', showing);
		if (state.error) {
			const offline = state.error.offline || !navigator.onLine;
			replace(placeholder, h('div', { class: 'status-sheet-error' },
				icon(offline ? 'offline' : 'alert'),
				h('h2', null, offline ? 'You’re Offline' : 'Couldn’t Load ' + (kind === 'status' ? 'the Status Page' : 'This Page')),
				h('p', null, offline ? 'It will load once you’re back online.' : 'Check your connection and try again.'),
				h('div', { class: 'actions' },
					button('Try Again', () => native.status.reload(), { kind: 'primary small', icon: 'refresh' }),
					button('Open in Browser', () => native.status.openInBrowser(kind), { kind: 'small', icon: 'external' }))));
		} else if (!showing) {
			replace(placeholder, h('div', { class: 'spinner large', role: 'progressbar', 'aria-label': 'Loading ' + noun }));
		} else {
			clear(placeholder);
		}
	}

	// Where the page goes: the sheet's body, once the sheet has come in.
	function layout() {
		if (!placed || closing) return;
		const r = body.getBoundingClientRect();
		native.status.layout({ x: r.left, y: r.top, width: r.width, height: r.height });
	}

	const observer = new ResizeObserver(() => layout());
	const onResize = () => layout();
	const onOnline = () => { if (state.error) native.status.reload(); };
	const onKey = (e) => {
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			close();
		}
	};
	const off = native.on('statuspage', (s) => {
		if (!s || !s.open) {
			// Closed from the page (Escape, Cmd+W) or by the app (a game, a link).
			close({ fromNative: true });
			return;
		}
		state = s;
		drawState();
	});

	function arrived() {
		if (placed || closing) return;
		placed = true;
		layout();
	}

	async function close({ fromNative = false } = {}) {
		if (closing) return;
		closing = true;
		observer.disconnect();
		window.removeEventListener('resize', onResize);
		window.removeEventListener('online', onOnline);
		document.removeEventListener('keydown', onKey, true);
		off();
		// The page goes first (a view can't fade with the sheet), then the
		// sheet goes the way it came.
		if (!fromNative) await native.status.close();
		body.classList.remove('loaded');
		backdrop.classList.add('closing');
		let finished = false;
		const finish = () => {
			if (finished) return;
			finished = true;
			if (root.contains(backdrop)) root.removeChild(backdrop);
			current = null;
			if (returnFocus && returnFocus.isConnected) returnFocus.focus();
			resolveClosed();
		};
		if (getComputedStyle(sheet).animationName === 'none') finish();
		else {
			sheet.addEventListener('animationend', finish, { once: true });
			setTimeout(finish, 400);
		}
	}

	drawState();
	replace(root, backdrop);
	done.focus();
	document.addEventListener('keydown', onKey, true);
	window.addEventListener('resize', onResize);
	window.addEventListener('online', onOnline);
	observer.observe(body);
	// The page is placed once the sheet has finished coming in (straight away
	// under Reduce Motion, where it does not move).
	if (getComputedStyle(sheet).animationName === 'none') requestAnimationFrame(arrived);
	else {
		sheet.addEventListener('animationend', arrived, { once: true });
		setTimeout(arrived, 450);
	}
	native.status.open(kind).then((s) => {
		if (closing) return;
		if (!s || !s.open) {
			// The window is between screens: the browser instead.
			native.status.openInBrowser(kind);
			close({ fromNative: true });
			return;
		}
		if ((s.kind || 'status') !== kind) {
			// An app from before the sheet held other pages: the browser.
			native.status.close().finally(() => native.external.open(kind));
			close({ fromNative: true });
			return;
		}
		state = s;
		drawState();
	}).catch(() => close({ fromNative: true }));

	current = { closed };
	return closed;
}
