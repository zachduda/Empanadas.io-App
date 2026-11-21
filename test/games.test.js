'use strict';

// The games kept on this computer (lib/gamebundle.js), what answers their
// requests (lib/gameprotocol.js), and the cookies the games session shares
// with the app's (lib/cookiebridge.js). A fake site stands in for
// empanadas.io; nothing here needs Electron.

const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const bundleLib = require('../lib/gamebundle');
const { createGameHandler, parseRange } = require('../lib/gameprotocol');
const { createCookieBridge, isSiteCookie, setDetails, clearSiteCookies } = require('../lib/cookiebridge');

const failures = [];
const queue = [];

// One at a time: these share a fake site whose files change between tests.
function check(what, fn) {
	queue.push([what, fn]);
}

async function runAll() {
	for (const [what, fn] of queue) {
		try {
			await fn();
			console.log('  ok    ' + what);
		} catch (err) {
			failures.push(what + ': ' + err.message);
			console.log('  FAIL  ' + what + ' - ' + err.stack);
		}
	}
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'empanadas-games-'));
const SITE = 'https://empanadas.io';

// --- A fake site --------------------------------------------------------

function page(name, extra = '') {
	return '<!doctype html><html><head>' +
		'<link rel="stylesheet" href="/Content/Code/CSS/' + name + '.css?v=1">' +
		'<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@500&amp;display=swap" rel="stylesheet">' +
		'<link rel="preconnect" href="https://fonts.gstatic.com">' +
		'<script async src="https://www.googletagmanager.com/gtag/js?id=G-X"></script>' +
		'</head><body><a href="/v2/dashboard">Back</a>' +
		'<img src=/Content/Images/empanada.webp>' + extra +
		'<script src="/Content/Code/JS/core.js"></script>' +
		'<script src="/Content/Code/JS/' + name + '.js"></script></body></html>';
}

function createSite() {
	const files = new Map();
	const put = (url, body, type) => files.set(url, { body: Buffer.from(body), type, etag: '"' + Math.random().toString(36).slice(2) + '"' });
	for (const name of ['spin', 'flappy', 'tower']) {
		put(SITE + '/' + name, page(name), 'text/html; charset=utf-8');
		put(SITE + '/Content/Code/CSS/' + name + '.css?v=1', 'body{background:url("../../Images/' + name + '-bg.png")}', 'text/css');
		put(SITE + '/Content/Code/JS/' + name + '.js', 'const s = "/Content/Sounds/' + name + '.mp3"; const dir = "/Content/Sounds/";', 'application/javascript');
		put(SITE + '/Content/Images/' + name + '-bg.png', 'png-' + name, 'image/png');
		put(SITE + '/Content/Sounds/' + name + '.mp3', 'mp3-' + name + '-0123456789', 'audio/mpeg');
	}
	files.get(SITE + '/spin').csp = "default-src 'self'";
	put(SITE + '/Content/Code/JS/core.js', 'core()', 'application/javascript');
	put(SITE + '/Content/Images/empanada.webp', 'webp', 'image/webp');
	put('https://fonts.googleapis.com/css2?family=Poppins:wght@500&display=swap',
		'@font-face{src:url(https://fonts.gstatic.com/s/poppins/v1/a.woff2) format("woff2"),url(https://fonts.gstatic.com/s/poppins/v1/a.ttf)}', 'text/css');
	put('https://fonts.gstatic.com/s/poppins/v1/a.woff2', 'woff2', 'font/woff2');

	const site = { files, requests: [], down: false, put };
	site.fetch = async (url, init = {}) => {
		const headers = init.headers || {};
		site.requests.push({ url, headers });
		if (site.down) throw new TypeError('fetch failed');
		const file = files.get(url);
		if (!file) return new Response('not found', { status: 404 });
		if (headers['If-None-Match'] === file.etag) return new Response(null, { status: 304, headers: { etag: file.etag } });
		const out = { 'content-type': file.type, etag: file.etag, 'content-length': String(file.body.length) };
		if (file.csp) out['content-security-policy'] = file.csp;
		return new Response(file.body, { status: 200, headers: out });
	};
	return site;
}

// --- Which files ----------------------------------------------------------

check('the pages are kept under one name each, whatever they are asked for with', () => {
	assert.strictEqual(bundleLib.keyOf(SITE + '/spin?au=1'), SITE + '/spin');
	assert.strictEqual(bundleLib.keyOf(SITE + '/spin.html#top'), SITE + '/spin');
	assert.strictEqual(bundleLib.keyOf(SITE + '/tower.html'), SITE + '/tower');
	assert.strictEqual(bundleLib.keyOf(SITE + '/Content/Code/CSS/spin.css?v=6.12.1'), SITE + '/Content/Code/CSS/spin.css?v=6.12.1');
});

check('only static files are kept: never the saves, another page, or another site', () => {
	for (const url of [
		SITE + '/v2/getdata.php', SITE + '/v2/updatedata.php', SITE + '/v2/dashboard', SITE + '/leaderboard',
		'https://api.empanadas.io/v1/clock.php', 'https://www.googletagmanager.com/gtag/js',
		'http://empanadas.io/spin', 'https://empanadas.io.evil.com/Content/x.js', 'https://evil.com/Content/x.js',
		SITE + '/Content/../v2/getdata.php', 'https://fonts.gstatic.com/s/a.ttf', 'https://fonts.googleapis.com/',
		'https://user:pw@empanadas.io/Content/x.js', 'https://empanadas.io:8443/Content/x.js'
	]) {
		assert.ok(!bundleLib.isEligible(url), url + ' would be kept');
	}
	for (const url of [SITE + '/favicon.ico', SITE + '/cdn-cgi/scripts/x/rocket.js', 'https://fonts.gstatic.com/s/a.woff2',
		'https://fonts.googleapis.com/css2?family=Poppins']) {
		assert.ok(bundleLib.isEligible(url), url + ' would not be kept');
	}
});

check('what a page, a stylesheet and a script name', () => {
	const named = bundleLib.namedInPage(page('spin'), SITE + '/spin');
	assert.ok(named.includes(SITE + '/Content/Code/CSS/spin.css?v=1'));
	assert.ok(named.includes('https://fonts.googleapis.com/css2?family=Poppins:wght@500&display=swap'), 'entities not decoded');
	assert.ok(named.includes(SITE + '/Content/Images/empanada.webp'), 'unquoted src missed');
	assert.ok(!named.some((u) => /dashboard|googletagmanager|gstatic\.com\/?$/.test(u)), named.join(', '));
	const css = bundleLib.namedInStylesheet('a{b:url(../fonts/x.woff2)} c{d:url("data:image/png;base64,AA")} @import "more.css"; e{f:url(x.svg#icon)}',
		SITE + '/Content/Code/CSS/a.css');
	assert.deepStrictEqual(css, [SITE + '/Content/Code/fonts/x.woff2', SITE + '/Content/Code/CSS/more.css']);
	const js = bundleLib.namedInScript('play("/Content/Sounds/a.mp3"); x = `/Content/Images/b.gif`; y = "/Content/Sounds/";', SITE + '/Content/Code/JS/a.js');
	assert.deepStrictEqual(js, [SITE + '/Content/Sounds/a.mp3', SITE + '/Content/Images/b.gif']);
});

// --- Syncing --------------------------------------------------------------

const site = createSite();
const dir = path.join(tmp, 'bundle');
let bundle = bundleLib.createBundle({ dir, fetch: site.fetch, userAgent: () => 'UA empanadas.io/2.0.0' });

check('a first sync finds every file from the pages down, and the games are ready', async () => {
	assert.ok(!bundle.status().games.spin.ready);
	const status = await bundle.sync();
	for (const name of ['spin', 'flappy', 'tower']) assert.ok(status.games[name].ready, name + ' not ready');
	assert.ok(status.complete, 'not complete: ' + status.lastError);
	for (const url of [SITE + '/Content/Images/spin-bg.png', SITE + '/Content/Sounds/tower.mp3', 'https://fonts.gstatic.com/s/poppins/v1/a.woff2']) {
		assert.ok(bundle.lookup(url), url + ' not kept');
	}
	assert.ok(!bundle.lookup('https://fonts.gstatic.com/s/poppins/v1/a.ttf'), 'kept a fallback font');
	assert.strictEqual(site.requests[0].headers['User-Agent'], 'UA empanadas.io/2.0.0');
});

check('the next sync only asks whether each file changed', async () => {
	site.requests.length = 0;
	await bundle.sync();
	const pageRequest = site.requests.find((r) => r.url === SITE + '/spin');
	assert.ok(pageRequest.headers['If-None-Match'], 'no conditional request');
	assert.ok(bundle.status().games.spin.ready);
});

check('a changed file is fetched again, and the old copy goes', async () => {
	const before = bundle.lookup(SITE + '/Content/Code/JS/core.js');
	site.put(SITE + '/Content/Code/JS/core.js', 'core(2)', 'application/javascript');
	await bundle.sync();
	const after = bundle.lookup(SITE + '/Content/Code/JS/core.js');
	assert.notStrictEqual(after.file, before.file);
	assert.strictEqual(fs.readFileSync(after.path, 'utf8'), 'core(2)');
	assert.ok(!fs.existsSync(before.path), 'the old copy is still on disk');
});

check('a game that starts asking for a new version of a file gets it', async () => {
	site.put(SITE + '/spin', page('spin').replace('spin.css?v=1', 'spin.css?v=2'), 'text/html');
	site.files.get(SITE + '/spin').csp = "default-src 'self'";
	site.put(SITE + '/Content/Code/CSS/spin.css?v=2', 'body{}', 'text/css');
	await bundle.sync();
	assert.ok(bundle.lookup(SITE + '/Content/Code/CSS/spin.css?v=2'));
	assert.ok(bundle.status().games.spin.ready);
});

check('a sync without a connection keeps the copy it has', async () => {
	site.down = true;
	const status = await bundle.sync();
	site.down = false;
	assert.ok(status.games.spin.ready && status.games.tower.ready);
	assert.ok(!status.complete);
	assert.ok(status.lastError);
});

check('a stylesheet the site itself answers 404 for does not keep a game from being ready', async () => {
	const file = site.files.get(SITE + '/Content/Code/CSS/flappy.css?v=1');
	site.files.delete(SITE + '/Content/Code/CSS/flappy.css?v=1');
	await bundle.sync();
	assert.ok(bundle.status().games.flappy.ready, 'flappy not ready over a file the site does not have');
	site.files.set(SITE + '/Content/Code/CSS/flappy.css?v=1', file);
	await bundle.sync();
	assert.ok(bundle.lookup(SITE + '/Content/Code/CSS/flappy.css?v=1'));
});

check('a game is not ready while a file it needs could not be fetched', async () => {
	const dir2 = path.join(tmp, 'partial');
	const partial = bundleLib.createBundle({ dir: dir2, fetch: async (url, init) => {
		if (url === SITE + '/Content/Code/JS/tower.js') throw new TypeError('connection reset');
		return site.fetch(url, init);
	} });
	const status = await partial.sync();
	assert.ok(!status.games.tower.ready, 'tower ready without its script');
	assert.ok(status.games.spin.ready);
});

check('a file the site no longer has is dropped', async () => {
	site.files.delete(SITE + '/Content/Images/empanada.webp');
	await bundle.sync();
	assert.strictEqual(bundle.lookup(SITE + '/Content/Images/empanada.webp'), null);
});

check('the copy is still there after a restart', () => {
	bundle.flush();
	bundle = bundleLib.createBundle({ dir, fetch: site.fetch });
	assert.ok(bundle.status().games.flappy.ready);
	assert.ok(bundle.lookup(SITE + '/flappy?x=1'));
});

check('a file a game fetched that the crawl had not found is kept', async () => {
	const url = SITE + '/Content/Images/SpinGame/new.png';
	assert.ok(await bundle.learn(url, new Response('new', { status: 200, headers: { 'content-type': 'image/png' } })));
	assert.strictEqual(fs.readFileSync(bundle.lookup(url).path, 'utf8'), 'new');
	assert.ok(!(await bundle.learn(SITE + '/v2/getdata.php', new Response('{}'))), 'kept a save');
});

// --- Answering the games ------------------------------------------------

function handlerFor(online = () => true) {
	const forwarded = [];
	const handle = createGameHandler({
		bundle,
		online,
		passThrough: async (request) => {
			forwarded.push(request.url);
			return site.fetch(request.url, { headers: {} });
		}
	});
	return { handle, forwarded };
}

check('a kept file is answered from disk, with the page\'s own security policy', async () => {
	const { handle, forwarded } = handlerFor();
	const res = await handle(new Request(SITE + '/spin?au=1'));
	assert.strictEqual(res.status, 200);
	assert.strictEqual(res.headers.get('content-security-policy'), "default-src 'self'");
	assert.strictEqual(res.headers.get('x-empanadas-app'), 'local');
	assert.match(await res.text(), /spin\.css\?v=2/);
	assert.strictEqual(forwarded.length, 0);
});

check('part of a sound is answered when asked for', async () => {
	const { handle } = handlerFor();
	const res = await handle(new Request(SITE + '/Content/Sounds/spin.mp3', { headers: { range: 'bytes=4-7' } }));
	assert.strictEqual(res.status, 206);
	assert.strictEqual(res.headers.get('content-range'), 'bytes 4-7/19');
	assert.strictEqual(await res.text(), 'spin');
	const head = await handle(new Request(SITE + '/Content/Sounds/spin.mp3', { method: 'HEAD' }));
	assert.strictEqual(head.headers.get('content-length'), '19');
	assert.strictEqual(parseRange('bytes=-5', 19).start, 14);
	assert.strictEqual(parseRange('bytes=30-', 19), 'unsatisfiable');
	assert.strictEqual(parseRange('items=0-1', 19), null);
});

check('the saves go to the network, and a new static file is kept on the way', async () => {
	site.put(SITE + '/v2/getdata.php', '{"save":1}', 'application/json');
	site.put(SITE + '/Content/Sounds/late.mp3', 'late', 'audio/mpeg');
	const { handle, forwarded } = handlerFor();
	assert.strictEqual(await (await handle(new Request(SITE + '/v2/getdata.php'))).text(), '{"save":1}');
	assert.strictEqual(await (await handle(new Request(SITE + '/Content/Sounds/late.mp3'))).text(), 'late');
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.deepStrictEqual(forwarded, [SITE + '/v2/getdata.php', SITE + '/Content/Sounds/late.mp3']);
	assert.ok(bundle.lookup(SITE + '/Content/Sounds/late.mp3'), 'not kept');
	assert.ok(!bundle.lookup(SITE + '/v2/getdata.php'));
});

check('offline, a kept game still starts and everything else fails at once', async () => {
	site.down = true;
	const { handle } = handlerFor(() => false);
	assert.strictEqual((await handle(new Request(SITE + '/tower'))).status, 200);
	const save = await handle(new Request(SITE + '/v2/getdata.php'));
	assert.strictEqual(save.type, 'error');
	site.down = false;
});

check('a kept file that went missing from disk is fetched instead', async () => {
	const entry = bundle.lookup(SITE + '/Content/Images/tower-bg.png');
	fs.rmSync(entry.path);
	const { handle, forwarded } = handlerFor();
	assert.strictEqual(await (await handle(new Request(SITE + '/Content/Images/tower-bg.png'))).text(), 'png-tower');
	assert.strictEqual(forwarded.length, 1);
});

check('clearing removes every kept file', async () => {
	await bundle.clear();
	assert.ok(!fs.existsSync(dir));
	assert.ok(!bundle.status().games.spin.ready);
	assert.strictEqual(bundle.status().files, 0);
});

// --- Cookies --------------------------------------------------------------

class FakeCookies extends EventEmitter {
	constructor() {
		super();
		this.jar = new Map();
	}
	key(name, domain, p) { return name + '|' + domain.replace(/^\./, '') + '|' + p; }
	async get() { return [...this.jar.values()].map((c) => Object.assign({}, c)); }
	async set(details) {
		const domain = details.domain || new URL(details.url).hostname;
		const cookie = { name: details.name, value: details.value, domain, path: details.path || '/', secure: !!details.secure,
			httpOnly: !!details.httpOnly, hostOnly: !details.domain, session: details.expirationDate === undefined,
			expirationDate: details.expirationDate, sameSite: details.sameSite || 'unspecified' };
		const k = this.key(cookie.name, domain, cookie.path);
		const old = this.jar.get(k);
		if (old) this.emit('changed', {}, old, 'overwrite', true);
		this.jar.set(k, cookie);
		this.emit('changed', {}, cookie, 'explicit', false);
	}
	async remove(url, name) {
		const host = new URL(url).hostname;
		for (const [k, c] of this.jar) {
			if (c.name === name && c.domain.replace(/^\./, '') === host) {
				this.jar.delete(k);
				this.emit('changed', {}, c, 'explicit', true);
			}
		}
	}
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

check('the games session gets the account\'s cookies, and no more', async () => {
	const main = new FakeCookies();
	const play = new FakeCookies();
	await main.set({ url: 'https://empanadas.io/v2', name: 'UAK', value: 'one', path: '/v2', secure: true, httpOnly: true, sameSite: 'lax' });
	await main.set({ url: 'https://empanadas.io/', name: '__cf_bm', value: 'cf', domain: '.empanadas.io' });
	await main.set({ url: 'https://other.com/', name: 'x', value: 'y' });
	await play.set({ url: 'https://empanadas.io/', name: 'OLD', value: 'stale' });
	const bridge = createCookieBridge(main, play);
	await bridge.syncAtoB();
	const names = (await play.get()).map((c) => c.name).sort();
	assert.deepStrictEqual(names, ['UAK']);
	const uak = (await play.get())[0];
	assert.strictEqual(uak.httpOnly, true);
	assert.strictEqual(uak.hostOnly, true, 'a host-only cookie was widened to a domain');
	assert.strictEqual(uak.path, '/v2');
});

check('a change on either side is copied to the other, without echoing back', async () => {
	const main = new FakeCookies();
	const play = new FakeCookies();
	const bridge = createCookieBridge(main, play);
	bridge.start();
	let mainChanges = 0;
	main.on('changed', () => mainChanges++);
	await main.set({ url: 'https://empanadas.io/', name: 'UAK', value: 'rotated' });
	await tick();
	assert.strictEqual((await play.get())[0].value, 'rotated');
	assert.strictEqual(mainChanges, 1, 'the copy echoed back to where it came from');
	await play.set({ url: 'https://empanadas.io/', name: 'UAK', value: 'from-game' });
	await tick();
	assert.strictEqual((await main.get())[0].value, 'from-game');
	await clearSiteCookies(main);
	await tick();
	assert.strictEqual((await play.get()).length, 0, 'a sign-out did not reach the games');
	bridge.stop();
	await main.set({ url: 'https://empanadas.io/', name: 'UAK', value: 'after' });
	await tick();
	assert.strictEqual((await play.get()).length, 0, 'still copying after stop()');
});

check('cookies of other sites and Cloudflare\'s are left alone', () => {
	assert.ok(!isSiteCookie({ name: 'cf_clearance', domain: '.empanadas.io' }));
	assert.ok(!isSiteCookie({ name: 'UAK', domain: 'empanadas.io.evil.com' }));
	assert.ok(isSiteCookie({ name: 'UAK', domain: '.api.empanadas.io' }));
	assert.strictEqual(setDetails({ name: 'a', value: 'b', domain: '.empanadas.io', hostOnly: false, path: '/' }).domain, '.empanadas.io');
});

runAll().then(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
	if (failures.length) {
		console.error('\n' + failures.length + ' game test(s) failed');
		process.exit(1);
	}
});
