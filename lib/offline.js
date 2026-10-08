'use strict';

// Offline games. The app needs a sign-in before it is any use, so once the
// player has signed in, Spin, Flappy and Tower keep working without a
// connection:
//
//  1. When the dashboard loads signed in, main.js registers the site's
//     /sw.js for the /spin, /flappy and /tower scopes. That worker (html/sw.js
//     in the Empanadas-io repo) keeps a copy of the games and serves it when
//     the network is not there. It lives on empanadas.io, so the games keep the
//     same localStorage - the same save - online and off, and sync it
//     themselves once the connection is back.
//  2. The splash page offers the games when it cannot reach the site, but
//     only while this file says the player is signed in and the worker is
//     installed for that game's scope. It opens them with ?offline=1 (offlinePlayUrl), which tells
//     the worker the site is unreachable, so the game starts from its stored
//     copy at once rather than waiting for the connection to time out.
//  3. Signing out forgets both, and main.js deletes the stored games.
//
// Everything here is plain Node so it can be tested without Electron.

const fs = require('fs');
const path = require('path');
const { isAppUrl } = require('./urls');

const SITE = 'https://empanadas.io';

// The only pages the offline copy covers, and so the only pages the splash may
// open without a connection. Anything else a caller names is refused.
const GAMES = Object.freeze({
	spin: SITE + '/spin',
	flappy: SITE + '/flappy',
	tower: SITE + '/tower'
});

// The worker's scopes: one per game page, so it controls nothing else on the
// site. Must match what html/sw.js expects.
const SCOPES = Object.freeze(['/spin', '/flappy', '/tower']);

// What a stored "ready" meant before the scopes were stored with it: the
// worker was registered for these two and nothing else. An install updated
// from then has no /tower worker until the dashboard next loads online, so
// Tower must not be offered offline before that.
const LEGACY_SCOPES = Object.freeze(['/spin', '/flappy']);

const DASHBOARD = /^\/v2\/dashboard(\.php)?$/;
const LOGIN = /^\/v2\/login(\.php)?$/;
const LOGOUT = /^\/v2\/auth\/logout(\.php)?$/;

function gameUrl(name) {
	return Object.prototype.hasOwnProperty.call(GAMES, name) ? GAMES[name] : null;
}

// May this game be opened without a connection? status is createStore().get().
function playableOffline(status, name) {
	return !!(status && status.available && Array.isArray(status.games) && gameUrl(name) !== null
		&& status.games.includes(name));
}

// Where the splash opens a game it has just failed to reach the site for. The
// worker takes ?offline=1 off again (a redirect to the plain address), so a
// reload once the connection is back is an ordinary one.
function offlinePlayUrl(name) {
	const url = gameUrl(name);
	return url ? url + '?offline=1' : null;
}

// Which game a URL is, or null. /spin, /spin.html and /spin?au=1 are all Spin.
function gameOf(url) {
	if (!isAppUrl(url)) return null;
	const pathname = new URL(url).pathname.replace(/\.html$/, '').replace(/\/+$/, '');
	for (const name of Object.keys(GAMES)) {
		if (new URL(GAMES[name]).pathname === pathname) return name;
	}
	return null;
}

function isDashboardUrl(url) {
	return isAppUrl(url) && DASHBOARD.test(new URL(url).pathname);
}

function header(headers, name) {
	for (const key of Object.keys(headers || {})) {
		if (key.toLowerCase() === name) {
			const value = headers[key];
			return Array.isArray(value) ? String(value[0] || '') : String(value || '');
		}
	}
	return '';
}

// What a response says about the sign-in, from the fields of Electron's
// webRequest.onHeadersReceived details. 'in', 'out', or null for "nothing".
//
//  - dashboard.php only answers 200 to a signed-in session; anyone else is
//    sent to the login page. So a 200 for it in the main window is a sign-in,
//    and a redirect from it to the login page is a session that has ended.
//  - Every sign-out goes through /v2/auth/logout.php (core.js's logoutJS()
//    opens it in a popup), whatever the page it started on.
function signInSignal(details) {
	if (!details || !isAppUrl(details.url)) return null;
	const pathname = new URL(details.url).pathname;

	if (LOGOUT.test(pathname)) return 'out';

	if (details.resourceType !== 'mainFrame' || !DASHBOARD.test(pathname)) return null;
	const status = Number(details.statusCode);
	if (status === 200) return 'in';
	if (status >= 300 && status < 400) {
		const location = header(details.responseHeaders, 'location');
		let target;
		try {
			target = new URL(location, details.url);
		} catch (err) {
			return null;
		}
		// Other redirects from the dashboard (the ad interstitial, an app too
		// old to be let in) say nothing about the session.
		if (target.origin === SITE && LOGIN.test(target.pathname)) return 'out';
	}
	return null;
}

// Runs in the dashboard's page (webContents.executeJavaScript) and resolves
// to the scopes whose game is stored for offline play, or null when the page
// has no service workers. Registering is what stores the games, so once this
// resolves they are playable offline - but only those it names:
//
//  - register() leaves an existing registration on the worker it already
//    has, so a worker from before a game was added would never learn it.
//    update() fetches /sw.js again; a failed one leaves the old worker going.
//  - A worker that failed to install (redundant) counts for nothing, and one
//    whose install could not fetch the game's page (install skips a file it
//    cannot get, and an old worker never asks for a page it does not know)
//    has nothing to serve offline. So a scope counts only with an active
//    worker and its page in the cache.
function registerScript() {
	return '(async () => {\n' +
		"  if (!('serviceWorker' in navigator)) return null;\n" +
		'  const scopes = ' + JSON.stringify(SCOPES) + ';\n' +
		"  const regs = await Promise.all(scopes.map((scope) => navigator.serviceWorker.register('/sw.js', { scope })));\n" +
		'  await Promise.all(regs.map((reg) => reg.update().catch(() => {})));\n' +
		'  await Promise.all(regs.map((reg) => {\n' +
		'    const worker = reg.installing || reg.waiting;\n' +
		'    if (!worker) return undefined;\n' +
		'    return new Promise((resolve) => {\n' +
		"      worker.addEventListener('statechange', () => {\n" +
		"        if (worker.state === 'activated' || worker.state === 'redundant') resolve();\n" +
		'      });\n' +
		'    });\n' +
		'  }));\n' +
		'  const stored = [];\n' +
		'  for (let i = 0; i < scopes.length; i++) {\n' +
		'    if (regs[i].active && await caches.match(scopes[i])) stored.push(scopes[i]);\n' +
		'  }\n' +
		'  return stored;\n' +
		'})()';
}

// The facts the splash needs, kept in the app's own data folder:
//   signedIn - the player has signed in on this install and not signed out;
//   ready    - the offline worker finished installing after that sign-in;
//   scopes   - the scopes it was installed for, so a game added in an update
//              is only offered once its worker is there.
// get() hands back signedIn and ready, the games playable offline, and
// available: whether any are.
function createStore(file) {
	const EMPTY = { signedIn: false, ready: false, scopes: [] };

	// The scopes this version knows, in its order, from a stored list.
	function known(list) {
		return SCOPES.filter((scope) => list.includes(scope));
	}

	function read() {
		try {
			const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
			const signedIn = saved.signedIn === true;
			const ready = signedIn && saved.ready === true;
			let scopes = [];
			if (ready) {
				scopes = Array.isArray(saved.scopes) ? known(saved.scopes) : [...LEGACY_SCOPES];
			}
			return { signedIn, ready, scopes };
		} catch (err) {
			return Object.assign({}, EMPTY, { scopes: [] });
		}
	}

	let state = read();

	function write() {
		try {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			// Written aside and renamed, so a crash mid-write cannot leave
			// half a file that reads as "signed out".
			const temp = file + '.tmp';
			fs.writeFileSync(temp, JSON.stringify(state));
			fs.renameSync(temp, file);
		} catch (err) {
			// Losing this costs offline play until the next sign-in, nothing
			// more; it is not worth failing anything over.
		}
	}

	function set(next) {
		if (next.signedIn === state.signedIn && next.ready === state.ready
			&& next.scopes.join() === state.scopes.join()) return false;
		state = next;
		write();
		return true;
	}

	function games() {
		if (!state.signedIn || !state.ready) return [];
		return Object.keys(GAMES).filter((name) => state.scopes.includes(new URL(GAMES[name]).pathname));
	}

	return {
		get: () => {
			const playable = games();
			return { available: playable.length > 0, signedIn: state.signedIn, ready: state.ready, games: playable };
		},
		signedIn: () => set({ signedIn: true, ready: state.ready, scopes: state.scopes }),
		signedOut: () => set(Object.assign({}, EMPTY, { scopes: [] })),
		// The scopes registerScript() found stored. Only counts while signed
		// in: a worker that finishes installing after a sign-out must not
		// bring offline play back.
		ready: (scopes) => state.signedIn
			? set({ signedIn: true, ready: true, scopes: known(Array.isArray(scopes) ? scopes : []) })
			: false
	};
}

module.exports = {
	SITE, GAMES, SCOPES, LEGACY_SCOPES,
	gameUrl, playableOffline, offlinePlayUrl, gameOf, isDashboardUrl, signInSignal, registerScript, createStore
};
