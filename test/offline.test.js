'use strict';

// lib/offline.js decides when the splash may offer the games without a
// connection: after a sign-in, once the site's worker has stored them, and
// never again after a sign-out. It needs nothing from Electron.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const {
	GAMES, SCOPES, gameUrl, offlinePlayUrl, gameOf, isDashboardUrl, signInSignal, registerScript, createStore
} = require('../lib/offline');

const failures = [];

const pending = [];

function check(what, fn) {
	const pass = () => console.log('  ok    ' + what);
	const fail = (err) => {
		failures.push(what + ': ' + err.message);
		console.log('  FAIL  ' + what + ' - ' + err.message);
	};
	try {
		const result = fn();
		if (result && typeof result.then === 'function') {
			pending.push(result.then(pass, fail));
		} else {
			pass();
		}
	} catch (err) {
		fail(err);
	}
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'empanadas-offline-'));

check('only the two games can be opened offline', () => {
	assert.strictEqual(gameUrl('spin'), 'https://empanadas.io/spin');
	assert.strictEqual(gameUrl('flappy'), 'https://empanadas.io/flappy');
	for (const name of ['dashboard', '', 'constructor', '__proto__', 'toString', '../v2/login', null, undefined]) {
		assert.strictEqual(gameUrl(name), null, JSON.stringify(name) + ' was accepted');
	}
	assert(Object.isFrozen(GAMES), 'GAMES can be changed at runtime');
});

check('a game opened from the splash tells the worker the site is unreachable', () => {
	// html/sw.js serves its stored copy at once for ?offline=1, and redirects
	// to the plain address.
	assert.strictEqual(offlinePlayUrl('spin'), 'https://empanadas.io/spin?offline=1');
	assert.strictEqual(offlinePlayUrl('flappy'), 'https://empanadas.io/flappy?offline=1');
	assert.strictEqual(offlinePlayUrl('dashboard'), null);
	assert.strictEqual(offlinePlayUrl('__proto__'), null);
	// If it fails anyway, the splash still names the game.
	assert.strictEqual(gameOf(offlinePlayUrl('spin')), 'spin');
});

check('the worker scopes are the game pages and nothing wider', () => {
	assert.deepStrictEqual([...SCOPES], ['/spin', '/flappy']);
});

check('names which game a URL is', () => {
	assert.strictEqual(gameOf('https://empanadas.io/spin?au=1'), 'spin');
	assert.strictEqual(gameOf('https://empanadas.io/spin.html'), 'spin');
	assert.strictEqual(gameOf('https://empanadas.io/flappy/'), 'flappy');
	assert.strictEqual(gameOf('https://empanadas.io/v2/dashboard'), null);
	assert.strictEqual(gameOf('https://empanadas.io.example.com/spin'), null);
	assert.strictEqual(gameOf('http://empanadas.io/spin'), null);
});

check('recognises the dashboard', () => {
	assert(isDashboardUrl('https://empanadas.io/v2/dashboard?usingnativeapp=1&appid=x'));
	assert(isDashboardUrl('https://empanadas.io/v2/dashboard.php'));
	assert(!isDashboardUrl('https://empanadas.io/v2/dashboardx'));
	assert(!isDashboardUrl('https://evil.example/v2/dashboard'));
});

const page = (url, statusCode, location) => ({
	url, statusCode, resourceType: 'mainFrame',
	responseHeaders: location ? { Location: [location] } : {}
});

check('a signed-in dashboard is a sign-in', () => {
	assert.strictEqual(signInSignal(page('https://empanadas.io/v2/dashboard?usingnativeapp=1', 200)), 'in');
});

check('only the main window loading the dashboard counts', () => {
	const xhr = Object.assign(page('https://empanadas.io/v2/dashboard', 200), { resourceType: 'xhr' });
	assert.strictEqual(signInSignal(xhr), null);
	assert.strictEqual(signInSignal(page('https://empanadas.io/v2/account', 200)), null);
	assert.strictEqual(signInSignal(page('https://evil.example/v2/dashboard', 200)), null);
});

check('the dashboard sending the app to the login page is a sign-out', () => {
	assert.strictEqual(signInSignal(page('https://empanadas.io/v2/dashboard', 302, 'login?redirect=v2/dashboard')), 'out');
	assert.strictEqual(signInSignal(page('https://empanadas.io/v2/dashboard', 302, '/v2/login.php')), 'out');
	// lower-case header names, as some responses carry them
	assert.strictEqual(signInSignal({ url: 'https://empanadas.io/v2/dashboard', statusCode: 302,
		resourceType: 'mainFrame', responseHeaders: { location: ['https://empanadas.io/v2/login'] } }), 'out');
});

check('other redirects from the dashboard say nothing about the session', () => {
	assert.strictEqual(signInSignal(page('https://empanadas.io/v2/dashboard', 302, 'ad?r=v2/dashboard')), null);
	assert.strictEqual(signInSignal(page('https://empanadas.io/v2/dashboard', 302, '/appoutofdate.html#v1.12.0')), null);
	assert.strictEqual(signInSignal(page('https://empanadas.io/v2/dashboard', 302, 'https://evil.example/v2/login')), null);
	assert.strictEqual(signInSignal(page('https://empanadas.io/v2/dashboard', 500)), null);
});

check('any request to logout.php is a sign-out', () => {
	const popup = { url: 'https://empanadas.io/v2/auth/logout.php?expected=1&r=/authcancel.html',
		statusCode: 302, resourceType: 'mainFrame', responseHeaders: {} };
	assert.strictEqual(signInSignal(popup), 'out');
	assert.strictEqual(signInSignal(Object.assign({}, popup, { resourceType: 'subFrame' })), 'out');
	assert.strictEqual(signInSignal(Object.assign({}, popup, { url: 'https://evil.example/v2/auth/logout.php' })), null);
});

check('starts signed out with nothing stored', () => {
	const store = createStore(path.join(tmp, 'a', 'offline.json'));
	assert.deepStrictEqual(store.get(), { available: false, signedIn: false, ready: false });
});

check('offline play needs a sign-in and the stored games', () => {
	const file = path.join(tmp, 'b', 'offline.json');
	const store = createStore(file);
	assert.strictEqual(store.ready(), false, 'ready before a sign-in');
	assert.strictEqual(store.get().available, false);
	store.signedIn();
	assert.strictEqual(store.get().available, false, 'available before the games are stored');
	store.ready();
	assert.strictEqual(store.get().available, true);
	// And it survives a restart.
	assert.deepStrictEqual(createStore(file).get(), { available: true, signedIn: true, ready: true });
});

check('signing out takes offline play away, and it stays away', () => {
	const file = path.join(tmp, 'c', 'offline.json');
	const store = createStore(file);
	store.signedIn();
	store.ready();
	store.signedOut();
	assert.deepStrictEqual(store.get(), { available: false, signedIn: false, ready: false });
	assert.deepStrictEqual(createStore(file).get(), { available: false, signedIn: false, ready: false });
	// Signing in again does not bring the old "ready" back: the stored games
	// were deleted with the sign-out, so they have to be stored again.
	store.signedIn();
	assert.strictEqual(store.get().available, false);
});

check('a damaged file reads as signed out', () => {
	const file = path.join(tmp, 'd.json');
	fs.writeFileSync(file, '{"signedIn": tru');
	assert.deepStrictEqual(createStore(file).get(), { available: false, signedIn: false, ready: false });
	fs.writeFileSync(file, JSON.stringify({ signedIn: 'yes', ready: true }));
	assert.deepStrictEqual(createStore(file).get(), { available: false, signedIn: false, ready: false });
	fs.writeFileSync(file, JSON.stringify({ signedIn: false, ready: true }));
	assert.strictEqual(createStore(file).get().ready, false, 'ready without a sign-in');
});

check('the registration script parses and registers both scopes', () => {
	const src = registerScript();
	new vm.Script(src); // throws on a syntax error
	for (const scope of SCOPES) assert(src.includes(JSON.stringify(scope)), scope + ' is not registered');
	assert(/register\('\/sw\.js'/.test(src), 'does not register /sw.js');
});

check('the registration script waits for the workers to activate', async () => {
	// Driven for real against a fake navigator.serviceWorker.
	const registered = [];
	const listeners = [];
	const worker = { state: 'installing', addEventListener: (t, fn) => listeners.push(fn) };
	const context = vm.createContext({
		navigator: { serviceWorker: { register: (url, opts) => {
			registered.push(opts.scope);
			return Promise.resolve({ active: null, installing: worker });
		} } },
		Promise, Error
	});
	let done = false;
	const result = vm.runInContext(registerScript(), context).then((v) => { done = v; });
	await new Promise((r) => setImmediate(r));
	assert.deepStrictEqual(registered, ['/spin', '/flappy']);
	assert.strictEqual(done, false, 'resolved before the workers were active');
	worker.state = 'activated';
	listeners.forEach((fn) => fn());
	await result;
	assert.strictEqual(done, true);
});

module.exports = { failures };

// The async checks report after the synchronous ones.
if (require.main === module) {
	Promise.all(pending).then(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
		if (failures.length) {
			console.error(failures.length + ' check(s) failed');
			process.exit(1);
		}
	});
}
