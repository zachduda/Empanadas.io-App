'use strict';

// The app's look, updated over the air.
//
// The screens (shell/) ship inside the app, and that copy always works. The
// site keeps a copy of its own too, under /Content/Desktop/v<SHELL_API>/
// (shell/'s files at the same paths: index.html, app.css, js/..., and
// optionally images/ and fonts/ to replace the app's own). The site says what
// is in it, with the SHA-256 of each file, at /v2/app/resources.php. At
// launch, while the loading screen shows, the app compares that list with the
// copy it keeps in <userData>/Resources and fetches only the files whose hash
// it does not have. A file is kept only if what arrived hashes to what the
// list said, and the new set is switched to in one rename of its index, once
// every file of it is on disk - so a launch cut short, or a deploy half
// uploaded when the app asked, leaves the last good set in use.
//
// What stays native and bundled whatever the site says: main.js, the preload
// scripts (the only code that can talk to the main process), the loading
// screen, the content security policy (set by main.js on every page, so a
// file from the site cannot loosen it), and every check made on IPC.
//
// When is the site's copy used?
//
//  - Only for the screens' contract this app speaks (SHELL_API in main.js,
//    bumped whenever the screens need something new of main.js or the
//    preload): a copy for another one is in another folder and never asked
//    for.
//  - Only when it was published from a later version of the app (the
//    manifest's "app", from scripts/publish-resources.js), or from this very
//    version's own screens (its "from": the revision of the shell/ the set was
//    copied from, which this app works out of its bundled copy). After an app
//    update the bundled screens are at least as new as an older set, so they
//    win until the site is published from the new version; and a build whose
//    screens changed without a new version number keeps its own rather than
//    an older set published under the same number.
//  - Not a set that failed to start (markBad(): main.js gives the screens a
//    few seconds to say they are up). That revision is skipped until the
//    site has another, and the bundled screens are shown.
//
// Plain Node: fetch is injected, as in lib/gamebundle.js.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const jsonfile = require('./jsonfile');

const SITE = 'https://empanadas.io';
const INDEX_VERSION = 1;

const MAX_FILES = 400;
const MAX_FILE = 8 * 1024 * 1024;
const MAX_TOTAL = 64 * 1024 * 1024;
const CONCURRENCY = 6;
const REQUEST_TIMEOUT = 20 * 1000;

// What the screens may be made of: the types main.js serves on app://shell.
const EXTENSIONS = new Set(['html', 'js', 'mjs', 'css', 'json', 'svg', 'png', 'gif', 'webp', 'woff2', 'ico']);

function manifestUrl(api) {
	return SITE + '/v2/app/resources.php?shell=' + encodeURIComponent(String(api));
}

function fileUrl(api, rel, hash) {
	// The hash in the address: a file's address changes with what is in it,
	// so no cache between here and the site can hand back an older one.
	return SITE + '/Content/Desktop/v' + api + '/' + rel.split('/').map(encodeURIComponent).join('/') + '?v=' + hash;
}

// A path as the manifest gives it: relative, plain characters, no "." or
// "_" segments (nginx refuses those under /Content/), an extension served.
function isSafePath(rel) {
	if (typeof rel !== 'string' || rel.length === 0 || rel.length > 200) return false;
	if (!/^[A-Za-z0-9][A-Za-z0-9_\-./]*$/.test(rel)) return false;
	const parts = rel.split('/');
	if (parts.some((part) => !part || part.startsWith('.') || part.startsWith('_'))) return false;
	const match = /\.([a-z0-9]+)$/i.exec(rel);
	return !!match && EXTENSIONS.has(match[1].toLowerCase());
}

const isHash = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

// "2.0.10" against "2.0.9": -1, 0 or 1. Anything after a "-" is ignored.
function compareVersions(a, b) {
	const parts = (v) => String(v || '0').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
	const x = parts(a);
	const y = parts(b);
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		const d = (x[i] || 0) - (y[i] || 0);
		if (d) return d > 0 ? 1 : -1;
	}
	return 0;
}

// The same revision for the same files whatever order they were listed in:
// the site computes it the same way (resources.php).
function revisionOf(files) {
	const lines = Object.keys(files).sort().map((rel) => rel + ' ' + files[rel].sha256 + '\n');
	return crypto.createHash('sha256').update(lines.join('')).digest('hex');
}

// The site's answer, checked. Returns { api, app, revision, files } or throws.
function parseManifest(body, api) {
	if (!body || typeof body !== 'object' || body.ok !== true) throw new Error('the site did not list the resources');
	if (Number(body.shell) !== api) throw new Error('the site listed resources for another version of the screens');
	const listed = body.files && typeof body.files === 'object' && !Array.isArray(body.files) ? body.files : {};
	const names = Object.keys(listed);
	if (names.length > MAX_FILES) throw new Error('the site listed too many files');
	const files = {};
	let total = 0;
	for (const rel of names) {
		const entry = listed[rel];
		if (!isSafePath(rel)) throw new Error('the site listed a file the app will not keep: ' + String(rel).slice(0, 80));
		if (!entry || !isHash(entry.sha256)) throw new Error('no hash for ' + rel);
		const size = Number(entry.size);
		if (!Number.isInteger(size) || size < 0 || size > MAX_FILE) throw new Error('bad size for ' + rel);
		total += size;
		files[rel] = { sha256: entry.sha256, size };
	}
	if (total > MAX_TOTAL) throw new Error('the resources are too big');
	const revision = revisionOf(files);
	if (body.revision && body.revision !== revision) throw new Error('the list of resources does not match its revision');
	return { api, app: typeof body.app === 'string' ? body.app.slice(0, 32) : '', from: isHash(body.from) ? body.from : '', revision, files };
}

// The revision of a folder of screens, as the site would list it: the bundled shell/, which a set
// published from it names as "from".
function revisionOfDir(dir) {
	const files = {};
	const walk = (at, prefix) => {
		for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
			const rel = prefix ? prefix + '/' + entry.name : entry.name;
			if (entry.isDirectory()) walk(path.join(at, entry.name), rel);
			else if (entry.isFile() && isSafePath(rel)) {
				const body = fs.readFileSync(path.join(at, entry.name));
				files[rel] = { sha256: sha256(body), size: body.length };
			}
		}
	};
	try {
		walk(dir, '');
	} catch (err) {
		return '';
	}
	return Object.keys(files).length ? revisionOf(files) : '';
}

function sha256(buffer) {
	return crypto.createHash('sha256').update(buffer).digest('hex');
}

// bundledRevision: revisionOfDir() of the screens built into the app ('' when unknown: then a set
// published from the same version is used, as before).
function createResources({ dir, fetch, api, appVersion, bundledRevision = '', userAgent = () => '', enabled = true, now = () => Date.now(), log = () => {} }) {
	const filesDir = path.join(dir, 'files');
	const indexFile = path.join(dir, 'index.json');

	function emptyIndex() {
		return { version: INDEX_VERSION, api, app: '', from: '', revision: '', files: {}, bad: [], checkedAt: 0, updatedAt: 0 };
	}

	// Whether a set published from app version `app`, copied from screens of revision `from`, is
	// newer than the bundled ones.
	function newerThanBundled(app, from) {
		const order = compareVersions(app, appVersion);
		if (order !== 0) return order > 0;
		return !bundledRevision || from === bundledRevision;
	}

	function loadIndex() {
		const saved = jsonfile.read(indexFile);
		if (!saved || saved.version !== INDEX_VERSION || typeof saved.files !== 'object' || !saved.files) return emptyIndex();
		const index = Object.assign(emptyIndex(), saved);
		if (!Array.isArray(index.bad)) index.bad = [];
		// A set with a file missing from disk is not a set: the bundled
		// screens until the next check fetches it again.
		for (const [rel, entry] of Object.entries(index.files)) {
			if (!isSafePath(rel) || !entry || !isHash(entry.sha256) || !fs.existsSync(path.join(filesDir, entry.sha256))) {
				return Object.assign(emptyIndex(), { bad: index.bad, checkedAt: index.checkedAt });
			}
		}
		return index;
	}

	let index = loadIndex();
	// Fixed for the life of the window: what was decided before the first
	// page loaded. A set fetched later is used from the next launch, so the
	// screens never change under the player's feet.
	let serving = null;
	let checking = null;
	let lastResult = null;

	function usable(ix) {
		return enabled && ix.api === api && !!ix.revision && Object.keys(ix.files).length > 0 &&
			newerThanBundled(ix.app, ix.from) && !ix.bad.includes(ix.revision);
	}

	function save() {
		jsonfile.write(indexFile, index);
	}

	async function get(url) {
		const headers = {};
		const ua = userAgent();
		if (ua) headers['User-Agent'] = ua;
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT);
		try {
			const res = await fetch(url, {
				method: 'GET', headers, cache: 'no-store', credentials: 'omit', redirect: 'error', signal: abort.signal
			});
			if (res.status !== 200) throw new Error('HTTP ' + res.status);
			const length = Number(res.headers.get('content-length') || 0);
			if (length > MAX_FILE) throw new Error('too big');
			const body = Buffer.from(await res.arrayBuffer());
			if (body.length > MAX_FILE) throw new Error('too big');
			return body;
		} finally {
			clearTimeout(timer);
		}
	}

	async function storeBlob(hash, buffer) {
		const target = path.join(filesDir, hash);
		if (fs.existsSync(target)) return;
		await fs.promises.mkdir(filesDir, { recursive: true });
		const temp = target + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
		await fs.promises.writeFile(temp, buffer);
		await fs.promises.rename(temp, target);
	}

	async function collectGarbage(keep) {
		let names;
		try {
			names = await fs.promises.readdir(filesDir);
		} catch (err) {
			return;
		}
		await Promise.all(names.filter((name) => !keep.has(name)).map((name) =>
			fs.promises.rm(path.join(filesDir, name), { force: true }).catch(() => {})));
	}

	// progress({ phase: 'checking' | 'downloading', done, total })
	async function run(progress) {
		const tell = (state) => {
			try { progress(state); } catch (err) { /* the loading screen's problem */ }
		};
		tell({ phase: 'checking', done: 0, total: 0 });
		const raw = await get(manifestUrl(api));
		let body;
		try {
			body = JSON.parse(raw.toString('utf8'));
		} catch (err) {
			throw new Error('the list of resources was not JSON');
		}
		const manifest = parseManifest(body, api);
		const checkedAt = now();

		// Nothing published for this app, or published from older screens than its own: the
		// bundled screens, and nothing kept that would not be used.
		if (!Object.keys(manifest.files).length || !newerThanBundled(manifest.app, manifest.from)) {
			const had = Object.keys(index.files).length > 0;
			index = Object.assign(emptyIndex(), { bad: index.bad, checkedAt });
			save();
			if (had) await collectGarbage(new Set());
			return { status: 'bundled', revision: '', changed: had };
		}

		if (index.bad.includes(manifest.revision)) {
			index.checkedAt = checkedAt;
			save();
			return { status: 'skipped', revision: manifest.revision, changed: false };
		}
		if (manifest.revision === index.revision) {
			index.checkedAt = checkedAt;
			index.app = manifest.app;
			index.from = manifest.from;
			save();
			return { status: 'current', revision: index.revision, changed: false };
		}

		const have = (hash) => fs.existsSync(path.join(filesDir, hash));
		const wanted = Object.entries(manifest.files).filter(([, entry]) => !have(entry.sha256));
		// Two names for the same contents are one download.
		const queue = [];
		const queued = new Set();
		for (const [rel, entry] of wanted) {
			if (!queued.has(entry.sha256)) {
				queued.add(entry.sha256);
				queue.push([rel, entry]);
			}
		}
		let done = 0;
		tell({ phase: 'downloading', done, total: queue.length });

		let next = 0;
		const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
			while (next < queue.length) {
				const [rel, entry] = queue[next++];
				const body = await get(fileUrl(api, rel, entry.sha256));
				if (body.length !== entry.size || sha256(body) !== entry.sha256) {
					// Most likely a deploy still uploading: try again next launch.
					throw new Error(rel + ' did not match its hash');
				}
				await storeBlob(entry.sha256, body);
				done++;
				tell({ phase: 'downloading', done, total: queue.length });
			}
		});
		await Promise.all(workers);

		const previous = index;
		index = {
			version: INDEX_VERSION, api, app: manifest.app, from: manifest.from, revision: manifest.revision, files: manifest.files,
			bad: previous.bad, checkedAt, updatedAt: now()
		};
		save();
		// Keep what the set in use right now names, as well as the new one.
		const keep = new Set(Object.values(manifest.files).map((e) => e.sha256));
		if (serving) for (const e of Object.values(serving.files)) keep.add(e.sha256);
		await collectGarbage(keep);
		log('[resources] updated to ' + manifest.revision.slice(0, 12) + ' (' + queue.length + ' file' + (queue.length === 1 ? '' : 's') + ' fetched)');
		return { status: 'updated', revision: manifest.revision, changed: true, fetched: queue.length };
	}

	return {
		// One check at a time; a second call while one runs gets the same one.
		// Resolves { status: current | updated | bundled | skipped | failed | off }.
		check(progress = () => {}) {
			if (!enabled) return Promise.resolve({ status: 'off', revision: '', changed: false });
			if (!checking) {
				checking = run(progress).catch((err) => {
					log('[resources] check failed: ' + err.message);
					return { status: 'failed', revision: index.revision, changed: false, error: err.message };
				}).then((result) => {
					lastResult = result;
					return result;
				}).finally(() => {
					checking = null;
				});
			}
			return checking;
		},

		get checking() { return checking; },

		// Decides which set the window shows, once. Called before the screens
		// first load; later calls give the same answer until reset().
		begin() {
			if (!serving) serving = usable(index) ? JSON.parse(JSON.stringify(index)) : { revision: '', files: {} };
			return serving.revision;
		},

		// The file on disk for a path of app://shell ("index.html",
		// "js/main.js", "images/logo.png"), or null for the bundled one.
		resolve(rel) {
			if (!serving) this.begin();
			if (!serving.revision) return null;
			const entry = Object.prototype.hasOwnProperty.call(serving.files, rel) ? serving.files[rel] : null;
			return entry ? path.join(filesDir, entry.sha256) : null;
		},

		// The set being shown did not start: never again, and the bundled
		// screens from now on.
		markBad(revision) {
			const bad = revision || (serving && serving.revision);
			if (!bad) return false;
			if (!index.bad.includes(bad)) index.bad = index.bad.concat([bad]).slice(-10);
			save();
			serving = { revision: '', files: {} };
			log('[resources] ' + bad.slice(0, 12) + ' did not start; using the screens built into the app');
			return true;
		},

		// After a check that changed something, the next begin() decides again.
		reset() {
			serving = null;
		},

		status() {
			return {
				enabled,
				api,
				serving: serving ? serving.revision : null,
				kept: index.revision,
				app: index.app,
				files: Object.keys(index.files).length,
				checkedAt: index.checkedAt || 0,
				updatedAt: index.updatedAt || 0,
				checking: !!checking,
				last: lastResult
			};
		}
	};
}

module.exports = {
	SITE, MAX_FILES, MAX_FILE, MAX_TOTAL, EXTENSIONS,
	manifestUrl, fileUrl, isSafePath, compareVersions, revisionOf, revisionOfDir, parseManifest,
	createResources
};
