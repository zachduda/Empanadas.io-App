'use strict';

// window.native: what the app's own screens (shell/, on app://shell) may ask
// of the main process. Every call is checked there again (isShellSender() in
// main.js): only the app's own page, in the app's own window, gets an answer.
//
// The screens never see a cookie, a csrf token or the network: they ask for
// a screen's data by name and get the site's answer back, or the copy kept
// for offline with when it was saved.

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

const EVENTS = new Set([
	'session', 'signin', 'data', 'games', 'game', 'route', 'refresh', 'back', 'toast', 'theme', 'window', 'background',
	'loading', 'statuspage'
]);

contextBridge.exposeInMainWorld('native', {
	platform: process.platform,
	info: () => invoke('app:info'),
	// The screens are drawn and working. Screens from the site
	// (lib/resources.js) that never say so are replaced with the app's own.
	ready: () => invoke('shell:ready'),

	// The loading screen (Content/Loading/, on app://loading): how the check
	// of the screens' files is going. Its updates come as on('loading').
	loading: { state: () => invoke('loading:state') },
	// Which copy of the screens is showing, and when the site was last asked.
	resources: { status: () => invoke('resources:status') },

	session: {
		get: () => invoke('session:get'),
		// mode: 'login' or 'create'. Opens the sign-in in the browser.
		signIn: (mode) => invoke('session:signIn', mode === 'create' ? 'create' : 'login'),
		cancel: () => invoke('session:cancelSignIn'),
		signOut: () => invoke('session:signOut')
	},

	// key: account, dashboard, leaderboard, profile ({ id }), search
	// ({ q, page }), feedbackForm, savePoints ({ before }), announcement
	// ({ page, id, fresh }), conversations, messages ({ id, before, after }).
	// Each resolves { ok, data, savedAt, fresh, error }. Actions include
	// sendMessage ({ id, text, nonce }), readMessages ({ id, upTo }),
	// blockPlayer ({ id, block }) and reportMessage ({ message, reason, note }).
	data: {
		cached: (key, params) => invoke('data:cached', String(key), params || {}),
		load: (key, params) => invoke('data:load', String(key), params || {}),
		act: (action, params) => invoke('data:act', String(action), params || {})
	},

	games: {
		status: () => invoke('games:status'),
		update: () => invoke('games:update'),
		clear: () => invoke('games:clear'),
		play: (name) => invoke('game:play', String(name)),
		close: () => invoke('game:close'),
		show: () => invoke('game:show'),
		state: () => invoke('game:state')
	},

	// name: account, picture, twoFactor, verifyEmail.
	site: { open: (name) => invoke('site:open', String(name)) },
	// The server status light (Statuspage's indicator, as the site's Updates
	// page shows it): resolves { level, checkedAt }, level one of checking,
	// operational, minor, major, critical or unknown. Cached for a minute
	// unless forced.
	//
	// And the full status page, in a sheet the screens draw: open() puts the
	// page up (off screen until layout() says where the sheet's body is, in
	// CSS pixels, or null to take it off screen), close() takes it away. Its
	// state comes as on('statuspage'): { open, hasContent, canGoBack, error,
	// background, kind, title }. open(name) takes status (the default), privacy
	// or terms: the site's legal pages go in the same sheet.
	status: {
		get: (force) => invoke('status:get', force === true),
		open: (name) => invoke('status:open', name === undefined ? undefined : String(name)),
		layout: (rect) => invoke('status:layout', rect && typeof rect === 'object'
			? { x: Number(rect.x), y: Number(rect.y), width: Number(rect.width), height: Number(rect.height) } : null),
		back: () => invoke('status:back'),
		reload: () => invoke('status:reload'),
		close: () => invoke('status:close'),
		openInBrowser: (name) => invoke('status:browser', name === undefined ? undefined : String(name))
	},
	// name: website, privacy, terms, source, updates, status.
	external: { open: (name) => invoke('external:open', String(name)) },

	background: {
		status: () => invoke('background-status'),
		set: (enabled) => invoke('background-set', enabled === true)
	},

	updater: {
		check: () => invoke('update-check'),
		state: () => invoke('update-state'),
		onState: (callback) => {
			const listener = (_event, state) => callback(state);
			ipcRenderer.on('updater:state', listener);
			return () => ipcRenderer.removeListener('updater:state', listener);
		}
	},

	cache: { size: () => invoke('cache:size'), clear: () => invoke('cache:clear') },
	prefs: { get: () => invoke('prefs:get'), set: (patch) => invoke('prefs:set', patch || {}) },
	theme: { get: () => invoke('theme:get'), set: (value) => invoke('theme:set', Number(value)) },
	// items: [{ id, label, enabled }] or { type: 'separator' }. Resolves the
	// id picked, or null.
	menu: { popup: (items) => invoke('menu:popup', items) },
	window: {
		toggleFullscreen: () => invoke('window:toggleFullscreen'),
		state: () => invoke('window:state'),
		zoom: () => invoke('window:zoom')
	},
	online: () => invoke('net:online'),

	on: (event, callback) => {
		if (!EVENTS.has(event) || typeof callback !== 'function') return () => {};
		const listener = (_event, payload) => callback(payload);
		ipcRenderer.on('native:' + event, listener);
		return () => ipcRenderer.removeListener('native:' + event, listener);
	}
});
