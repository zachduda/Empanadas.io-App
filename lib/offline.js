'use strict';

// Offline games. The app needs a sign-in before it is any use, so once the
// player has signed in, Spin and Flappy keep working without a connection:
//
//  1. When the dashboard loads signed in, main.js registers the site's
//     /sw.js for the /spin and /flappy scopes. That worker (html/sw.js in the
//     Empanadas-io repo) keeps a copy of both games and serves it when the
//     network is not there. It lives on empanadas.io, so the games keep the
//     same localStorage - the same save - online and off, and sync it
//     themselves once the connection is back.
//  2. The splash page offers the games when it cannot reach the site, but
//     only while this file says the player is signed in and the worker is
//     installed.
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
	flappy: SITE + '/flappy'
});

// The worker's scopes: one per game page, so it controls nothing else on the
// site. Must match what html/sw.js expects.
const SCOPES = Object.freeze(['/spin', '/flappy']);

const DASHBOARD = /^\/v2\/dashboard(\.php)?$/;
const LOGIN = /^\/v2\/login(\.php)?$/;
const LOGOUT = /^\/v2\/auth\/logout(\.php)?$/;

function gameUrl(name) {
	return Object.prototype.hasOwnProperty.call(GAMES, name) ? GAMES[name] : null;
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
// true once the worker is active for both scopes - installing it is what
// stores the games, so this is the moment they are playable offline.
function registerScript() {
	return '(async () => {\n' +
		"  if (!('serviceWorker' in navigator)) return false;\n" +
		'  const regs = await Promise.all(' + JSON.stringify(SCOPES) + '.map((scope) =>\n' +
		"    navigator.serviceWorker.register('/sw.js', { scope })));\n" +
		'  await Promise.all(regs.map((reg) => reg.active || new Promise((resolve, reject) => {\n' +
		'    const worker = reg.installing || reg.waiting;\n' +
		'    if (!worker) { resolve(); return; }\n' +
		"    worker.addEventListener('statechange', () => {\n" +
		"      if (worker.state === 'activated') resolve();\n" +
		"      else if (worker.state === 'redundant') reject(new Error('the offline worker did not install'));\n" +
		'    });\n' +
		'  })));\n' +
		'  return true;\n' +
		'})()';
}

// The two facts the splash needs, kept in the app's own data folder:
//   signedIn - the player has signed in on this install and not signed out;
//   ready    - the offline worker finished installing after that sign-in.
function createStore(file) {
	const EMPTY = { signedIn: false, ready: false };

	function read() {
		try {
			const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
			return { signedIn: saved.signedIn === true, ready: saved.signedIn === true && saved.ready === true };
		} catch (err) {
			return Object.assign({}, EMPTY);
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
		if (next.signedIn === state.signedIn && next.ready === state.ready) return false;
		state = next;
		write();
		return true;
	}

	return {
		get: () => Object.assign({ available: state.signedIn && state.ready }, state),
		signedIn: () => set({ signedIn: true, ready: state.ready }),
		signedOut: () => set(Object.assign({}, EMPTY)),
		// Only counts while signed in: a worker that finishes installing after
		// a sign-out must not bring offline play back.
		ready: () => state.signedIn ? set({ signedIn: true, ready: true }) : false
	};
}

module.exports = {
	SITE, GAMES, SCOPES,
	gameUrl, gameOf, isDashboardUrl, signInSignal, registerScript, createStore
};
