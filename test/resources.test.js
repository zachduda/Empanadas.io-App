'use strict';

// The screens' files over the air (lib/resources.js): the site's list read
// and checked, only changed files fetched, a file kept only if it hashes to
// what the list said, a set switched to only whole, and the rules for when
// the site's copy is used over the one built in. A fake site stands in for
// empanadas.io; nothing here needs Electron.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const lib = require('../lib/resources');

const failures = [];
const queue = [];
function check(what, fn) {
	queue.push([what, fn]);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'empanadas-resources-'));
let dirs = 0;
const freshDir = () => path.join(tmp, 'r' + (++dirs));
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

// A site with a folder of screens and the list of them, as resources.php.
function createSite({ app = '2.0.0', shell = 1 } = {}) {
	const files = new Map();
	const site = {
		app,
		shell,
		requests: [],
		// What the site serves under a path, when it differs from the list
		// (a deploy half uploaded).
		served: new Map(),
		down: false,
		put(rel, text) { files.set(rel, Buffer.from(text)); },
		remove(rel) { files.delete(rel); },
		list() {
			const out = {};
			for (const [rel, body] of files) out[rel] = { sha256: sha(body), size: body.length };
			return out;
		},
		async fetch(url) {
			site.requests.push(url);
			if (site.down) throw new Error('getaddrinfo ENOTFOUND');
			const u = new URL(url);
			if (u.pathname === '/v2/app/resources.php') {
				const listed = site.list();
				const body = { ok: true, api: 1, shell: Number(u.searchParams.get('shell')), app: site.app, revision: lib.revisionOf(listed), files: listed };
				if (body.shell !== site.shell) Object.assign(body, { app: '', files: {}, revision: lib.revisionOf({}) });
				return respond(200, JSON.stringify(body));
			}
			const prefix = '/Content/Desktop/v' + site.shell + '/';
			if (u.pathname.startsWith(prefix)) {
				const rel = decodeURIComponent(u.pathname.slice(prefix.length));
				if (site.served.has(rel)) return respond(200, site.served.get(rel));
				if (files.has(rel)) return respond(200, files.get(rel));
			}
			return respond(404, 'not found');
		}
	};
	return site;
}

function respond(status, body) {
	const buffer = Buffer.from(body);
	return {
		status,
		headers: new Map([['content-length', String(buffer.length)]]),
		arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length)
	};
}

function make(site, opts = {}) {
	return lib.createResources(Object.assign({
		dir: opts.dir || freshDir(),
		fetch: (url, init) => site.fetch(url, init),
		api: 1,
		appVersion: '2.0.0'
	}, opts));
}

function standardSite(opts) {
	const site = createSite(opts);
	site.put('index.html', '<!doctype html><title>site</title>');
	site.put('app.css', 'body{color:blue}');
	site.put('js/main.js', 'console.log(1)');
	return site;
}

// --- paths and versions ------------------------------------------------

check('paths the app keeps, and the ones it refuses', () => {
	for (const ok of ['index.html', 'app.css', 'js/screens/home.js', 'images/logo.png', 'fonts/Poppins-400.woff2']) {
		assert.ok(lib.isSafePath(ok), ok);
	}
	for (const bad of ['', '/index.html', '../main.js', 'js/../../x.js', 'js/./a.js', '.hidden.css', '_release.json',
		'js/_x/a.js', 'a.php', 'a.exe', 'LICENSE', 'a b.css', 'js//a.js', 'C:\\x.js', 'x.js\u0000.png', 'é.css']) {
		assert.ok(!lib.isSafePath(bad), JSON.stringify(bad));
	}
});

check('versions compare by number', () => {
	assert.strictEqual(lib.compareVersions('2.0.10', '2.0.9'), 1);
	assert.strictEqual(lib.compareVersions('2.0.0', '2.0'), 0);
	assert.strictEqual(lib.compareVersions('1.12.3', '2.0.0'), -1);
	assert.strictEqual(lib.compareVersions('2.1.0-beta', '2.1.0'), 0);
	assert.strictEqual(lib.compareVersions('', '0.0.1'), -1);
});

check('the address of a file has its hash in it', () => {
	const url = lib.fileUrl(1, 'js/screens/home.js', 'a'.repeat(64));
	assert.strictEqual(url, 'https://empanadas.io/Content/Desktop/v1/js/screens/home.js?v=' + 'a'.repeat(64));
});

check('a list the app will not take', () => {
	const good = { 'a.css': { sha256: 'a'.repeat(64), size: 1 } };
	const base = { ok: true, shell: 1, app: '2.0.0', files: good };
	assert.ok(lib.parseManifest(base, 1));
	assert.throws(() => lib.parseManifest(Object.assign({}, base, { ok: false }), 1));
	assert.throws(() => lib.parseManifest(Object.assign({}, base, { shell: 2 }), 1), /another version/);
	assert.throws(() => lib.parseManifest(Object.assign({}, base, { files: { '../x.js': good['a.css'] } }), 1), /will not keep/);
	assert.throws(() => lib.parseManifest(Object.assign({}, base, { files: { 'a.css': { sha256: 'nope', size: 1 } } }), 1), /no hash/);
	assert.throws(() => lib.parseManifest(Object.assign({}, base, { files: { 'a.css': { sha256: 'a'.repeat(64), size: -1 } } }), 1), /bad size/);
	assert.throws(() => lib.parseManifest(Object.assign({}, base, { revision: 'b'.repeat(64) }), 1), /revision/);
	const many = {};
	for (let i = 0; i <= lib.MAX_FILES; i++) many['f' + i + '.js'] = { sha256: 'a'.repeat(64), size: 1 };
	assert.throws(() => lib.parseManifest(Object.assign({}, base, { files: many }), 1), /too many/);
});

// --- checking and fetching ------------------------------------------------

check('first launch: every file fetched, checked, and served from disk', async () => {
	const site = standardSite();
	const r = make(site);
	const progress = [];
	const result = await r.check((p) => progress.push(p));
	assert.strictEqual(result.status, 'updated');
	assert.strictEqual(result.fetched, 3);
	assert.deepStrictEqual(progress[0], { phase: 'checking', done: 0, total: 0 });
	assert.deepStrictEqual(progress[progress.length - 1], { phase: 'downloading', done: 3, total: 3 });
	assert.ok(r.begin());
	const file = r.resolve('app.css');
	assert.strictEqual(fs.readFileSync(file, 'utf8'), 'body{color:blue}');
	assert.strictEqual(r.resolve('js/screens/missing.js'), null, 'a file the site does not have is the bundled one');
	assert.ok(site.requests.every((u) => u.startsWith('https://empanadas.io/')), 'only ever the site');
});

check('next launch: nothing changed, only the list asked for', async () => {
	const site = standardSite();
	const dir = freshDir();
	await make(site, { dir }).check();
	site.requests.length = 0;
	const again = make(site, { dir });
	const result = await again.check();
	assert.strictEqual(result.status, 'current');
	assert.strictEqual(site.requests.length, 1);
	assert.ok(again.begin());
});

check('a changed file: only it fetched', async () => {
	const site = standardSite();
	const dir = freshDir();
	await make(site, { dir }).check();
	site.put('app.css', 'body{color:gold}');
	site.requests.length = 0;
	const r = make(site, { dir });
	const result = await r.check();
	assert.strictEqual(result.status, 'updated');
	assert.strictEqual(result.fetched, 1);
	assert.strictEqual(site.requests.filter((u) => u.includes('/Content/')).length, 1);
	r.begin();
	assert.strictEqual(fs.readFileSync(r.resolve('app.css'), 'utf8'), 'body{color:gold}');
});

check('a file that does not match its hash: the last good set stays', async () => {
	const site = standardSite();
	const dir = freshDir();
	await make(site, { dir }).check();
	site.put('app.css', 'body{color:green}');
	site.served.set('app.css', 'body{color:half-uploaded');
	const r = make(site, { dir });
	const result = await r.check();
	assert.strictEqual(result.status, 'failed');
	assert.match(result.error, /did not match its hash/);
	r.begin();
	assert.strictEqual(fs.readFileSync(r.resolve('app.css'), 'utf8'), 'body{color:blue}');
	// Uploaded now: the next launch takes it.
	site.served.clear();
	const later = make(site, { dir });
	assert.strictEqual((await later.check()).status, 'updated');
	later.begin();
	assert.strictEqual(fs.readFileSync(later.resolve('app.css'), 'utf8'), 'body{color:green}');
});

check('offline: what is on disk, unchanged', async () => {
	const site = standardSite();
	const dir = freshDir();
	await make(site, { dir }).check();
	site.down = true;
	const r = make(site, { dir });
	assert.strictEqual((await r.check()).status, 'failed');
	assert.ok(r.begin());
	assert.ok(r.resolve('index.html'));
});

check('the set in use stays the same for the window, whatever the check finds later', async () => {
	const site = standardSite();
	const dir = freshDir();
	await make(site, { dir }).check();
	const r = make(site, { dir });
	const first = r.begin();
	site.put('app.css', 'body{color:pink}');
	assert.strictEqual((await r.check()).status, 'updated');
	assert.strictEqual(r.begin(), first);
	assert.strictEqual(fs.readFileSync(r.resolve('app.css'), 'utf8'), 'body{color:blue}', 'the old file is still on disk');
	r.reset();
	assert.notStrictEqual(r.begin(), first);
	assert.strictEqual(fs.readFileSync(r.resolve('app.css'), 'utf8'), 'body{color:pink}');
});

check('a file missing from disk: the bundled screens until it is fetched again', async () => {
	const site = standardSite();
	const dir = freshDir();
	const r = make(site, { dir });
	await r.check();
	r.begin();
	fs.rmSync(r.resolve('app.css'));
	const after = make(site, { dir });
	assert.strictEqual(after.begin(), '');
	assert.strictEqual(after.resolve('index.html'), null);
	assert.strictEqual((await after.check()).status, 'updated');
});

check('only for the app version it was published from or older', async () => {
	const site = standardSite({ app: '2.0.0' });
	const dir = freshDir();
	await make(site, { dir, appVersion: '1.99.0' }).check();
	assert.ok(make(site, { dir, appVersion: '1.99.0' }).begin(), 'an older app takes it');
	assert.ok(make(site, { dir, appVersion: '2.0.0' }).begin(), 'the same app takes it');
	// The app updated, the site not yet published from it: its own screens.
	const newer = make(site, { dir, appVersion: '2.1.0' });
	assert.strictEqual(newer.begin(), '');
	const result = await newer.check();
	assert.strictEqual(result.status, 'bundled');
	assert.ok(!fs.existsSync(path.join(dir, 'files')) || fs.readdirSync(path.join(dir, 'files')).length === 0, 'nothing kept that will not be used');
});

check('nothing published for these screens: the bundled ones', async () => {
	const site = standardSite({ shell: 2 });
	const r = make(site);
	assert.strictEqual((await r.check()).status, 'bundled');
	assert.strictEqual(r.begin(), '');
	assert.ok(site.requests[0].endsWith('resources.php?shell=1'));
});

check('emptied on the site: back to the bundled screens', async () => {
	const site = standardSite();
	const dir = freshDir();
	await make(site, { dir }).check();
	for (const rel of ['index.html', 'app.css', 'js/main.js']) site.remove(rel);
	const r = make(site, { dir });
	const result = await r.check();
	assert.strictEqual(result.status, 'bundled');
	assert.ok(result.changed);
	assert.strictEqual(make(site, { dir }).begin(), '');
});

check('a set that did not start is never used again, until the site has another', async () => {
	const site = standardSite();
	const dir = freshDir();
	await make(site, { dir }).check();
	const r = make(site, { dir });
	const bad = r.begin();
	assert.ok(r.markBad());
	assert.strictEqual(r.begin(), '', 'the bundled screens at once');
	assert.strictEqual(r.resolve('index.html'), null);
	const next = make(site, { dir });
	assert.strictEqual(next.begin(), '', 'and next launch');
	assert.strictEqual((await next.check()).status, 'skipped');
	site.put('app.css', 'body{color:fixed}');
	const fixed = make(site, { dir });
	assert.strictEqual((await fixed.check()).status, 'updated');
	assert.ok(fixed.begin() && fixed.begin() !== bad);
});

check('turned off: no requests, the bundled screens', async () => {
	const site = standardSite();
	const r = make(site, { enabled: false });
	assert.strictEqual((await r.check()).status, 'off');
	assert.strictEqual(site.requests.length, 0);
	assert.strictEqual(r.begin(), '');
});

check('one check at a time', async () => {
	const site = standardSite();
	const r = make(site);
	const [a, b] = [r.check(), r.check()];
	assert.strictEqual(a, b);
	await a;
	assert.strictEqual(site.requests.filter((u) => u.includes('resources.php')).length, 1);
});

check('two names for the same contents are one download', async () => {
	const site = createSite();
	site.put('index.html', '<!doctype html>');
	site.put('images/a.png', 'same');
	site.put('images/b.png', 'same');
	const r = make(site);
	assert.strictEqual((await r.check()).fetched, 2);
	r.begin();
	assert.strictEqual(r.resolve('images/a.png'), r.resolve('images/b.png'));
});

check('status says what is showing', async () => {
	const site = standardSite();
	const r = make(site, { now: () => 1234 });
	await r.check();
	r.begin();
	const s = r.status();
	assert.strictEqual(s.enabled, true);
	assert.strictEqual(s.files, 3);
	assert.strictEqual(s.app, '2.0.0');
	assert.strictEqual(s.serving, s.kept);
	assert.strictEqual(s.updatedAt, 1234);
});

(async () => {
	for (const [what, fn] of queue) {
		try {
			await fn();
			console.log('  ok    ' + what);
		} catch (err) {
			failures.push(what + ': ' + err.message);
			console.log('  FAIL  ' + what + ' - ' + err.stack);
		}
	}
	fs.rmSync(tmp, { recursive: true, force: true });
	if (failures.length) process.exit(1);
})();
