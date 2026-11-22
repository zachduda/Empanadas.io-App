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
	'session', 'signin', 'data', 'games', 'game', 'route', 'refresh', 'back', 'toast', 'theme', 'window', 'background'
]);

contextBridge.exposeInMainWorld('native', {
	platform: process.platform,
	info: () => invoke('app:info'),

	session: {
		get: () => invoke('session:get'),
		// mode: 'login' or 'create'. Opens the sign-in in the browser.
		signIn: (mode) => invoke('session:signIn', mode === 'create' ? 'create' : 'login'),
		cancel: () => invoke('session:cancelSignIn'),
		signOut: () => invoke('session:signOut')
	},

	// key: account, dashboard, leaderboard, profile ({ id }), search
	// ({ q, page }), feedbackForm, savePoints ({ before }), announcement
	// ({ page, id, fresh }). Each resolves { ok, data, savedAt, fresh, error }.
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
	// name: website, privacy, terms, source, updates.
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
