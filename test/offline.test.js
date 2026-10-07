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
	GAMES, SCOPES, LEGACY_SCOPES, gameUrl, playableOffline, offlinePlayUrl, gameOf, isDashboardUrl, signInSignal,
	registerScript, createStore
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

check('only the three games can be opened offline', () => {
	assert.strictEqual(gameUrl('spin'), 'https://empanadas.io/spin');
	assert.strictEqual(gameUrl('flappy'), 'https://empanadas.io/flappy');
	assert.strictEqual(gameUrl('tower'), 'https://empanadas.io/tower');
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
	assert.strictEqual(offlinePlayUrl('tower'), 'https://empanadas.io/tower?offline=1');
	assert.strictEqual(offlinePlayUrl('dashboard'), null);
	assert.strictEqual(offlinePlayUrl('__proto__'), null);
	// If it fails anyway, the splash still names the game.
	assert.strictEqual(gameOf(offlinePlayUrl('spin')), 'spin');
});

check('the worker scopes are the game pages and nothing wider', () => {
	assert.deepStrictEqual([...SCOPES], ['/spin', '/flappy', '/tower']);
	for (const name of Object.keys(GAMES)) {
		assert(SCOPES.includes(new URL(GAMES[name]).pathname), name + ' has no scope');
	}
});

check('names which game a URL is', () => {
	assert.strictEqual(gameOf('https://empanadas.io/spin?au=1'), 'spin');
	assert.strictEqual(gameOf('https://empanadas.io/spin.html'), 'spin');
	assert.strictEqual(gameOf('https://empanadas.io/flappy/'), 'flappy');
	assert.strictEqual(gameOf('https://empanadas.io/tower.html'), 'tower');
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
	assert.deepStrictEqual(store.get(), { available: false, signedIn: false, ready: false, games: [] });
});

check('offline play needs a sign-in and the stored games', () => {
	const file = path.join(tmp, 'b', 'offline.json');
	const store = createStore(file);
	assert.strictEqual(store.ready([...SCOPES]), false, 'ready before a sign-in');
	assert.strictEqual(store.get().available, false);
	store.signedIn();
	assert.strictEqual(store.get().available, false, 'available before the games are stored');
	store.ready([...SCOPES]);
	assert.strictEqual(store.get().available, true);
	// And it survives a restart.
	assert.deepStrictEqual(createStore(file).get(),
		{ available: true, signedIn: true, ready: true, games: ['spin', 'flappy', 'tower'] });
});

check('signing out takes offline play away, and it stays away', () => {
	const file = path.join(tmp, 'c', 'offline.json');
	const store = createStore(file);
	store.signedIn();
	store.ready([...SCOPES]);
	store.signedOut();
	assert.deepStrictEqual(store.get(), { available: false, signedIn: false, ready: false, games: [] });
	assert.deepStrictEqual(createStore(file).get(), { available: false, signedIn: false, ready: false, games: [] });
	// Signing in again does not bring the old "ready" back: the stored games
	// were deleted with the sign-out, so they have to be stored again.
	store.signedIn();
	assert.strictEqual(store.get().available, false);
});

check('a damaged file reads as signed out', () => {
	const file = path.join(tmp, 'd.json');
	fs.writeFileSync(file, '{"signedIn": tru');
	assert.deepStrictEqual(createStore(file).get(), { available: false, signedIn: false, ready: false, games: [] });
	fs.writeFileSync(file, JSON.stringify({ signedIn: 'yes', ready: true }));
	assert.deepStrictEqual(createStore(file).get(), { available: false, signedIn: false, ready: false, games: [] });
	fs.writeFileSync(file, JSON.stringify({ signedIn: false, ready: true }));
	assert.strictEqual(createStore(file).get().ready, false, 'ready without a sign-in');
});

check('a save from before Tower offers only the games its worker was installed for', () => {
	// offline.json as an app from before /tower wrote it: no scopes.
	const file = path.join(tmp, 'e', 'offline.json');
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify({ signedIn: true, ready: true }));
	const store = createStore(file);
	assert.deepStrictEqual(store.get(), { available: true, signedIn: true, ready: true, games: ['spin', 'flappy'] });
	assert.deepStrictEqual([...LEGACY_SCOPES], ['/spin', '/flappy']);
	assert(playableOffline(store.get(), 'spin') && playableOffline(store.get(), 'flappy'));
	assert(!playableOffline(store.get(), 'tower'), 'Tower offered before its worker was installed');
	// The next dashboard load online registers every scope, and then it is.
	assert.strictEqual(store.ready(['/spin', '/flappy', '/tower']), true, 'recording the new scopes is a change');
	assert(playableOffline(store.get(), 'tower'));
	assert.deepStrictEqual(createStore(file).get().games, ['spin', 'flappy', 'tower']);
});

check('stored scopes this version does not know are ignored', () => {
	const file = path.join(tmp, 'f.json');
	fs.writeFileSync(file, JSON.stringify({ signedIn: true, ready: true, scopes: ['/tower', '/v2', 42, '/spin'] }));
	assert.deepStrictEqual(createStore(file).get().games, ['spin', 'tower']);
	fs.writeFileSync(file, JSON.stringify({ signedIn: true, ready: true, scopes: [] }));
	assert.deepStrictEqual(createStore(file).get(), { available: false, signedIn: true, ready: true, games: [] });
});

check('ready() records only the scopes it is given', () => {
	const file = path.join(tmp, 'g', 'offline.json');
	const store = createStore(file);
	store.signedIn();
	store.ready(['/spin', '/tower']);
	assert.deepStrictEqual(store.get().games, ['spin', 'tower']);
	assert.deepStrictEqual(createStore(file).get().games, ['spin', 'tower'], 'not kept across a restart');
	// A later registration finding less stored is believed too.
	store.ready(['/flappy']);
	assert.deepStrictEqual(store.get().games, ['flappy']);
	store.ready(['/v2', 7, '/flappy', '/flappy']);
	assert.deepStrictEqual(store.get().games, ['flappy'], 'unknown or repeated scopes were kept');
	for (const junk of [undefined, null, '/spin', { 0: '/spin' }]) {
		store.ready(junk);
		assert.deepStrictEqual(store.get(), { available: false, signedIn: true, ready: true, games: [] }, String(junk));
	}
});

check('only a game in the status can be played offline', () => {
	const status = { available: true, signedIn: true, ready: true, games: ['spin'] };
	assert(playableOffline(status, 'spin'));
	assert(!playableOffline(status, 'flappy'));
	assert(!playableOffline(Object.assign({}, status, { available: false }), 'spin'));
	assert(!playableOffline({ available: true }, 'spin'), 'no games list');
	assert(!playableOffline(Object.assign({}, status, { games: ['__proto__'] }), '__proto__'));
	assert(!playableOffline(null, 'spin'));
});

check('the registration script parses and registers every scope', () => {
	const src = registerScript();
	new vm.Script(src); // throws on a syntax error
	for (const scope of SCOPES) assert(src.includes(JSON.stringify(scope)), scope + ' is not registered');
	assert(/register\('\/sw\.js'/.test(src), 'does not register /sw.js');
});

// A fake navigator.serviceWorker and Cache API for registerScript(). Each
// scope's registration starts installing; finish(scope, state) moves it on.
// pages are the game pages in the cache.
function fakeWorkers({ pages = [...SCOPES], updateFails = false } = {}) {
	const registered = [];
	const updated = [];
	const regs = {};
	const context = vm.createContext({
		navigator: { serviceWorker: { register: (url, opts) => {
			registered.push(url + ' ' + opts.scope);
			if (!regs[opts.scope]) {
				const listeners = [];
				const worker = { state: 'installing', addEventListener: (t, fn) => listeners.push(fn) };
				regs[opts.scope] = {
					active: null, installing: worker, waiting: null, listeners,
					update: () => { updated.push(opts.scope); return updateFails ? Promise.reject(new Error('offline')) : Promise.resolve(); }
				};
			}
			return Promise.resolve(regs[opts.scope]);
		} } },
		caches: { match: (url) => Promise.resolve(pages.includes(url) ? {} : undefined) },
		Promise, Error
	});
	const finish = (scope, state) => {
		const reg = regs[scope];
		const worker = reg.installing;
		worker.state = state;
		reg.installing = null;
		if (state === 'activated') reg.active = worker;
		reg.listeners.forEach((fn) => fn());
	};
	return { context, registered, updated, finish };
}

const tick = () => new Promise((r) => setImmediate(r));

check('the registration script waits for every worker, then names the stored games', async () => {
	const fake = fakeWorkers();
	let done;
	const result = vm.runInContext(registerScript(), fake.context).then((v) => { done = v; });
	await tick();
	assert.deepStrictEqual(fake.registered, ['/sw.js /spin', '/sw.js /flappy', '/sw.js /tower']);
	assert.deepStrictEqual(fake.updated, ['/spin', '/flappy', '/tower'], 'an existing worker is not refreshed');
	fake.finish('/spin', 'activated');
	fake.finish('/flappy', 'activated');
	await tick();
	assert.strictEqual(done, undefined, 'resolved before every worker was active');
	fake.finish('/tower', 'activated');
	await result;
	assert.deepStrictEqual(Array.from(done), ['/spin', '/flappy', '/tower']);
});

check('a worker that did not install, or a page not stored, is left out', async () => {
	const fake = fakeWorkers({ pages: ['/spin', '/flappy'] });
	const result = vm.runInContext(registerScript(), fake.context);
	await tick();
	fake.finish('/spin', 'redundant');
	fake.finish('/flappy', 'activated');
	fake.finish('/tower', 'activated');
	// /spin: no worker. /tower: a worker, but (say, the site's sw.js from
	// before Tower) it stored no Tower page.
	assert.deepStrictEqual(Array.from(await result), ['/flappy']);
});

check('a failed update still waits for the workers and reports them', async () => {
	const fake = fakeWorkers({ updateFails: true });
	const result = vm.runInContext(registerScript(), fake.context);
	await tick();
	for (const scope of SCOPES) fake.finish(scope, 'activated');
	assert.deepStrictEqual(Array.from(await result), [...SCOPES]);
});

check('with no service workers, the registration script reports nothing stored', async () => {
	const context = vm.createContext({ navigator: {}, Promise, Error });
	assert.strictEqual(await vm.runInContext(registerScript(), context), null);
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
