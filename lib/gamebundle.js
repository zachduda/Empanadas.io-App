'use strict';

// The games, kept on this computer.
//
// Spin, Flappy and Tower are the site's own pages and scripts. Rather than
// load them from the network every time (and rely on the site's service
// worker to have kept a copy for offline), the app keeps a copy of every file
// they need in its data folder, and serves it from there (lib/gameprotocol.js)
// under the site's own address, https://empanadas.io/spin - so the games keep
// the same origin, localStorage (their saves) and cookies as ever, and their
// saves still go to the site as before. Only the static files are local: the
// pages, stylesheets, scripts, pictures, sounds and fonts.
//
// Which files: worked out from the games themselves, a step at a time, as the
// iOS app does (ios/Empanadas/Core/OfflineAssets.swift): each game's page,
// then the stylesheets, scripts and pictures it names, then the fonts and
// pictures the stylesheets name and the pictures and sounds the scripts name,
// plus the files Spin builds the path of in script. A file a game asks for
// that none of that found is kept the first time it is fetched (learn()), so
// nothing has to be listed by hand for it to work offline next time.
//
// Kept up to date by asking the site whether each file changed (If-None-Match
// / If-Modified-Since), usually a page of 304s. Files are stored by the hash
// of what is in them, and the index naming them is replaced in one rename, so
// a sync that stops half way leaves a working copy behind.
//
// Plain Node: fetch is injected.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const jsonfile = require('./jsonfile');

const SITE = 'https://empanadas.io';
const APP_HOST = 'empanadas.io';
const FONT_CSS_HOST = 'fonts.googleapis.com';
const FONT_FILE_HOST = 'fonts.gstatic.com';

const INDEX_VERSION = 1;

const GAMES = Object.freeze({ spin: '/spin', flappy: '/flappy', tower: '/tower' });

// The pages, under one key each however they were asked for (/spin?au=1 from
// the dashboard, /spin.html from an old link). As html/sw.js's PAGES.
const PAGES = Object.freeze({
	'/spin': '/spin', '/spin.html': '/spin',
	'/flappy': '/flappy', '/flappy.html': '/flappy',
	'/tower': '/tower', '/tower.html': '/tower'
});

// Files a game builds the path of in script, so no page, stylesheet or script
// names them whole (OfflineAssets.builtInScript), and the rest of the site
// worker's PRECACHE list (html/sw.js). Anything missing from here is still
// learnt the first time a game asks for it online.
const SEEDS = Object.freeze([
	'/favicon.ico',
	'/Content/Sounds/button.mp3',
	'/Content/Sounds/error.wav',
	'/Content/Sounds/soundtoggle.mp3',
	'/Content/Sounds/gameoversound.mp3',
	'/Content/Sounds/flappy_ost_mid.mp3',
	'/Content/Sounds/flappy_ost_mid_100.mp3',
	'/Content/Sounds/SpinGame/achievement.mp3',
	'/Content/Sounds/SpinGame/cheating_alert.mp3',
	'/Content/Sounds/SpinGame/cheating_confirmed.mp3',
	'/Content/Sounds/SpinGame/extinguish.mp3',
	'/Content/Sounds/SpinGame/golden.mp3',
	'/Content/Sounds/SpinGame/golden_active.mp3',
	'/Content/Sounds/SpinGame/locked.mp3',
	'/Content/Sounds/SpinGame/menu.mp3',
	'/Content/Sounds/SpinGame/prestige.mp3',
	'/Content/Sounds/SpinGame/smokealarm.mp3',
	'/Content/Sounds/SpinGame/timetravel.mp3',
	'/Content/Sounds/SpinGame/zap.mp3',
	...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => '/Content/Sounds/SpinGame/Speenz/' + n + '.mp3'),
	'/Content/Images/empanada.webp',
	'/Content/Images/blank.png',
	'/Content/Images/SpinGame/burnt_empanada.png',
	'/Content/Images/SpinGame/golden_empanada.png',
	'/Content/Images/SpinGame/fire.png',
	'/Content/Images/SpinGame/smokealarm.png',
	'/Content/Images/SpinGame/extinguisher.png',
	...[1, 2, 3].map((n) => '/Content/Images/SpinGame/Medals/' + n + '.png'),
	...[4, 5, 6].map((n) => '/Content/Images/SpinGame/Medals/' + n + '.gif'),
	'/Content/Images/Jeff/jeff.png',
	'/Content/Images/Jeff/jeff.gif',
	'/Content/Images/Jeff/jeffbigneck.gif',
	'/Content/Images/Jeff/jeffcoffee.gif',
	'/Content/Images/Jeff/jeffhat.gif',
	'/Content/Images/Jeff/jeffhearts.gif',
	'/Content/Icons/pepper.png',
	'/Content/Icons/favicon-32x32.png'
]);

// Response headers kept with a file and given back with it. The pages' own
// security headers come back with them, so a game served from disk runs
// under the same policy as one from the site.
const KEPT_HEADERS = Object.freeze([
	'content-type', 'content-security-policy', 'content-security-policy-report-only',
	'referrer-policy', 'permissions-policy', 'x-content-type-options',
	'cross-origin-opener-policy', 'cross-origin-embedder-policy', 'cross-origin-resource-policy'
]);

const MAX_FILE = 25 * 1024 * 1024;
const CONCURRENCY = 6;
const REQUEST_TIMEOUT = 20 * 1000;
// A learnt file nothing names any more is kept this long after it was last
// used, then dropped (an old spin.css?v=... after an update).
const LEARNT_KEEP = 30 * 24 * 60 * 60 * 1000;

function parse(url) {
	try {
		const parsed = url instanceof URL ? new URL(url.href) : new URL(String(url));
		return parsed.protocol === 'https:' ? parsed : null;
	} catch (err) {
		return null;
	}
}

// Font formats a stylesheet lists after woff2 for older browsers.
function isFallbackFont(pathname) {
	return /\.(ttf|otf|eot|woff)$/i.test(pathname);
}

function pageOf(parsed) {
	if (!parsed || parsed.hostname !== APP_HOST) return null;
	return Object.prototype.hasOwnProperty.call(PAGES, parsed.pathname) ? PAGES[parsed.pathname] : null;
}

// Is this a file the games are kept with? The pages, the site's static files
// (everything under /Content/), the favicon, the scripts Cloudflare adds to
// pages (/cdn-cgi/scripts/), and Google Fonts. Never anything under /v2/ or
// another host's: the saves, the clock and the analytics tag stay online.
function isEligible(url) {
	const parsed = parse(url);
	if (!parsed || parsed.username || parsed.password || parsed.port) return false;
	const p = parsed.pathname;
	switch (parsed.hostname) {
	case APP_HOST:
		if (pageOf(parsed)) return true;
		if (p === '/favicon.ico') return true;
		if (p.startsWith('/cdn-cgi/scripts/')) return true;
		return p.startsWith('/Content/') && !p.includes('..') && !isFallbackFont(p);
	case FONT_CSS_HOST:
		return p.startsWith('/css');
	case FONT_FILE_HOST:
		return p.length > 1 && !isFallbackFont(p);
	default:
		return false;
	}
}

// The key a file is kept under: its address without the fragment, and a page
// under its one name, without the query (the page is the same file whatever
// it is asked for with).
function keyOf(url) {
	const parsed = parse(url);
	if (!parsed || !isEligible(parsed)) return null;
	parsed.hash = '';
	const page = pageOf(parsed);
	if (page) return SITE + page;
	return parsed.href;
}

function gameOfKey(key) {
	for (const [name, page] of Object.entries(GAMES)) if (key === SITE + page) return name;
	return null;
}

function extensionOf(key) {
	const parsed = parse(key);
	const match = parsed && /\.([a-z0-9]+)$/i.exec(parsed.pathname);
	return match ? match[1].toLowerCase() : '';
}

function kindOf(key, type) {
	const t = String(type || '').toLowerCase();
	if (gameOfKey(key) || t.startsWith('text/html')) return 'page';
	const parsed = parse(key);
	if (t.includes('css') || extensionOf(key) === 'css' || (parsed && parsed.hostname === FONT_CSS_HOST)) return 'css';
	if (t.includes('javascript') || extensionOf(key) === 'js') return 'js';
	return 'file';
}

// --- What a file names ------------------------------------------------

function decodeEntities(value) {
	return value.replace(/&amp;/g, '&').replace(/&#38;/g, '&').replace(/&quot;/g, '"');
}

function firstGroups(regex, text) {
	const out = [];
	regex.lastIndex = 0;
	let match;
	while ((match = regex.exec(text)) !== null) {
		for (let i = 1; i < match.length; i++) {
			if (match[i] !== undefined) {
				out.push(match[i]);
				break;
			}
		}
	}
	return out;
}

function resolved(references, base) {
	const seen = new Set();
	const out = [];
	for (const raw of references) {
		const reference = String(raw).trim();
		if (!reference || /^(data|blob|javascript|mailto):/i.test(reference)) continue;
		let url;
		try {
			url = new URL(reference, base);
		} catch (err) {
			continue;
		}
		const key = keyOf(url);
		if (key && !seen.has(key)) {
			seen.add(key);
			out.push(key);
		}
	}
	return out;
}

// src="..." or href="...", in either quotes or none.
const ATTRIBUTE = /\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
// url(...), in either quotes or none.
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s"'()]+))\s*\)/gi;
// @import "..." in a stylesheet.
const CSS_IMPORT = /@import\s+(?:"([^"]*)"|'([^']*)')/gi;
// A whole path under /Content/ with a picture, sound or font's extension,
// in quotes. Not a folder a script adds the rest of the path to.
const SCRIPT_PATH = /["'`](\/Content\/[A-Za-z0-9_\-./]+\.(?:png|gif|webp|jpe?g|svg|ico|mp3|wav|ogg|m4a|woff2|json))["'`]/gi;

function namedInPage(html, base) {
	return resolved(firstGroups(ATTRIBUTE, html).map(decodeEntities), base);
}

function namedInStylesheet(css, base) {
	const refs = firstGroups(CSS_URL, css).concat(firstGroups(CSS_IMPORT, css)).filter((reference) =>
		!reference.startsWith('#') && !(reference.includes('#') && /\.svg/i.test(reference)));
	return resolved(refs, base);
}

function namedInScript(js, base) {
	return resolved(firstGroups(SCRIPT_PATH, js), base);
}

function namedIn(key, type, text) {
	switch (kindOf(key, type)) {
	case 'page': return namedInPage(text, key);
	case 'css': return namedInStylesheet(text, key);
	case 'js': return namedInScript(text, key);
	default: return [];
	}
}

// What a game cannot start without: its page and the site's own scripts and
// stylesheets the page names. Pictures and sounds it can do without for a
// moment, and they are fetched online if missing.
function requiredBy(pageKey, html) {
	return namedInPage(html, pageKey).filter((key) => {
		const parsed = parse(key);
		const kind = kindOf(key, '');
		return parsed && parsed.hostname === APP_HOST && (kind === 'js' || kind === 'css');
	});
}

function sha256(buffer) {
	return crypto.createHash('sha256').update(buffer).digest('hex');
}

function keptHeaders(headers) {
	const out = {};
	for (const name of KEPT_HEADERS) {
		const value = headers && typeof headers.get === 'function' ? headers.get(name) : null;
		if (value) out[name] = value;
	}
	return out;
}

// --- The bundle on disk -----------------------------------------------

function createBundle({ dir, fetch, userAgent = () => '', now = () => Date.now(), log = () => {} }) {
	const filesDir = path.join(dir, 'files');
	const indexFile = path.join(dir, 'index.json');

	function emptyIndex() {
		return { version: INDEX_VERSION, files: {}, pages: {}, gone: [], syncedAt: 0, complete: false };
	}

	function loadIndex() {
		const saved = jsonfile.read(indexFile);
		if (!saved || saved.version !== INDEX_VERSION || typeof saved.files !== 'object') return emptyIndex();
		const index = Object.assign(emptyIndex(), saved);
		// A file the index names that is not on disk (cleared by hand, a
		// disk tool) is forgotten rather than served as an error.
		for (const [key, entry] of Object.entries(index.files)) {
			if (!entry || typeof entry.file !== 'string' || !/^[0-9a-f]{64}$/.test(entry.file) ||
				!fs.existsSync(path.join(filesDir, entry.file))) {
				delete index.files[key];
			}
		}
		return index;
	}

	let index = loadIndex();
	let syncing = null;
	let progress = { done: 0, total: 0 };
	let lastError = null;
	let saveTimer = null;
	const listeners = new Set();

	function emit() {
		for (const fn of listeners) {
			try { fn(); } catch (err) { /* a listener's problem */ }
		}
	}

	function saveIndex() {
		if (saveTimer) {
			clearTimeout(saveTimer);
			saveTimer = null;
		}
		jsonfile.write(indexFile, index);
	}

	// Usage times change on every play: written a little later, in one go.
	function saveIndexSoon() {
		if (saveTimer) return;
		saveTimer = setTimeout(() => {
			saveTimer = null;
			jsonfile.write(indexFile, index);
		}, 5000);
		if (saveTimer.unref) saveTimer.unref();
	}

	async function storeBlob(buffer) {
		const hash = sha256(buffer);
		const target = path.join(filesDir, hash);
		if (!fs.existsSync(target)) {
			await fs.promises.mkdir(filesDir, { recursive: true });
			const temp = target + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
			await fs.promises.writeFile(temp, buffer);
			await fs.promises.rename(temp, target);
		}
		return hash;
	}

	function entryFor(key, res, hash, size, extra) {
		return Object.assign({
			file: hash,
			size,
			type: res.headers.get('content-type') || '',
			headers: keptHeaders(res.headers),
			etag: res.headers.get('etag') || null,
			lastModified: res.headers.get('last-modified') || null,
			fetchedAt: now(),
			checkedAt: now()
		}, extra || {});
	}

	async function readText(entry) {
		try {
			return await fs.promises.readFile(path.join(filesDir, entry.file), 'utf8');
		} catch (err) {
			return '';
		}
	}

	async function get(key, previous) {
		const headers = {};
		const ua = userAgent();
		if (ua) headers['User-Agent'] = ua;
		if (previous && previous.etag) headers['If-None-Match'] = previous.etag;
		if (previous && previous.lastModified) headers['If-Modified-Since'] = previous.lastModified;
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT);
		try {
			const res = await fetch(key, {
				method: 'GET', headers, cache: 'no-store', credentials: 'omit', redirect: 'follow', signal: abort.signal
			});
			if (res.status !== 200) return { res, body: null };
			const length = Number(res.headers.get('content-length') || 0);
			if (length > MAX_FILE) return { res, body: null, tooBig: true };
			const body = Buffer.from(await res.arrayBuffer());
			if (body.length > MAX_FILE) return { res, body: null, tooBig: true };
			return { res, body };
		} finally {
			clearTimeout(timer);
		}
	}

	async function run() {
		const started = now();
		const before = index;
		const files = {};
		const pages = {};
		const queue = [];
		const queued = new Set();
		// What the site answered 404 for: a game is no less ready for a file
		// it would not get online either.
		const gone = new Set();
		let failed = 0;
		let reachedPages = 0;

		const enqueue = (key) => {
			if (key && !queued.has(key)) {
				queued.add(key);
				queue.push(key);
			}
		};
		for (const page of Object.values(GAMES)) enqueue(SITE + page);
		for (const seed of SEEDS) enqueue(keyOf(SITE + seed));
		// Every file kept so far is checked again, except a learnt one that
		// has not been used for a long while (an old spin.css?v=... after an
		// update): that goes, unless the crawl finds it named again below.
		const stale = (entry) => entry.learnt && now() - (entry.usedAt || entry.fetchedAt || 0) > LEARNT_KEEP;
		for (const [key, entry] of Object.entries(before.files)) {
			if (!stale(entry)) enqueue(key);
		}

		progress = { done: 0, total: queue.length };
		emit();

		const handle = async (key) => {
			const previous = before.files[key];
			let entry = null;
			let text = null;
			try {
				const { res, body } = await get(key, previous);
				if (res.status === 304 && previous) {
					entry = Object.assign({}, previous, { checkedAt: now() });
					if (kindOf(key, entry.type) !== 'file') text = await readText(entry);
				} else if (res.status === 200 && body) {
					const hash = await storeBlob(body);
					entry = entryFor(key, res, hash, body.length);
					if (previous && previous.learnt) entry.learnt = true;
					if (previous && previous.usedAt) entry.usedAt = previous.usedAt;
					if (kindOf(key, entry.type) !== 'file') text = body.toString('utf8');
				} else if (res.status === 404 || res.status === 410) {
					// Gone from the site: gone from here.
					gone.add(key);
					return;
				} else {
					failed++;
					entry = previous || null;
					if (entry && kindOf(key, entry.type) !== 'file') text = await readText(entry);
				}
			} catch (err) {
				failed++;
				entry = previous || null;
				if (entry && kindOf(key, entry.type) !== 'file') text = await readText(entry);
			}
			if (!entry) return;
			files[key] = entry;
			if (text) {
				for (const named of namedIn(key, entry.type, text)) enqueue(named);
				const game = gameOfKey(key);
				if (game) {
					pages[game] = requiredBy(key, text);
					reachedPages++;
				}
			}
		};

		let next = 0;
		const workers = Array.from({ length: CONCURRENCY }, async () => {
			while (next < queue.length) {
				const key = queue[next++];
				await handle(key);
				progress = { done: progress.done + 1, total: queue.length };
				if (progress.done % 10 === 0) emit();
			}
		});
		await Promise.all(workers);

		// Anything learnt while this sync ran.
		for (const [key, entry] of Object.entries(index.files)) {
			if (!files[key] && entry.learnt && (entry.fetchedAt || 0) >= started) files[key] = entry;
		}

		index = {
			version: INDEX_VERSION,
			files,
			pages: Object.assign({}, before.pages, pages),
			gone: [...gone],
			syncedAt: now(),
			complete: failed === 0 && reachedPages === Object.keys(GAMES).length
		};
		saveIndex();
		lastError = failed ? failed + ' file' + (failed === 1 ? '' : 's') + " couldn't be updated" : null;
		await collectGarbage();
		log('[games] synced ' + Object.keys(files).length + ' files' + (failed ? ', ' + failed + ' failed' : ''));
		return status();
	}

	// Removes stored files the index no longer names.
	async function collectGarbage() {
		const wanted = new Set(Object.values(index.files).map((e) => e.file));
		let names;
		try {
			names = await fs.promises.readdir(filesDir);
		} catch (err) {
			return;
		}
		await Promise.all(names.map(async (name) => {
			if (wanted.has(name)) return;
			// A blob being written by learn() right now is still a .tmp.
			if (name.endsWith('.tmp')) {
				try {
					const stat = await fs.promises.stat(path.join(filesDir, name));
					if (now() - stat.mtimeMs < 60 * 1000) return;
				} catch (err) {
					return;
				}
			}
			await fs.promises.rm(path.join(filesDir, name), { force: true }).catch(() => {});
		}));
	}

	function gameReady(name) {
		const page = SITE + GAMES[name];
		if (!index.files[page]) return false;
		const required = index.pages && index.pages[name];
		if (!Array.isArray(required)) return false;
		const gone = new Set(Array.isArray(index.gone) ? index.gone : []);
		return required.every((key) => !!index.files[key] || gone.has(key));
	}

	function status() {
		const games = {};
		for (const name of Object.keys(GAMES)) games[name] = { ready: gameReady(name) };
		let bytes = 0;
		const blobs = new Set();
		for (const entry of Object.values(index.files)) {
			if (!blobs.has(entry.file)) {
				blobs.add(entry.file);
				bytes += entry.size || 0;
			}
		}
		return {
			games,
			files: Object.keys(index.files).length,
			bytes,
			syncedAt: index.syncedAt || 0,
			complete: !!index.complete,
			syncing: !!syncing,
			progress: Object.assign({}, progress),
			lastError
		};
	}

	return {
		isEligible,
		keyOf,

		// The kept file for a request's address, or null.
		lookup(url) {
			const key = keyOf(url);
			if (!key) return null;
			const entry = index.files[key];
			if (!entry) return null;
			entry.usedAt = now();
			saveIndexSoon();
			return Object.assign({ key, path: path.join(filesDir, entry.file) }, entry);
		},

		// Keeps a file a game fetched that the crawl had not found. res is
		// the answer the game got (a clone of it).
		async learn(url, res) {
			const key = keyOf(url);
			if (!key || index.files[key] || !res || res.status !== 200) return false;
			const length = Number(res.headers.get('content-length') || 0);
			if (length > MAX_FILE) return false;
			const body = Buffer.from(await res.arrayBuffer());
			if (!body.length || body.length > MAX_FILE) return false;
			const hash = await storeBlob(body);
			index.files[key] = entryFor(key, res, hash, body.length, { learnt: true, usedAt: now() });
			if (gameOfKey(key)) index.pages[gameOfKey(key)] = requiredBy(key, body.toString('utf8'));
			saveIndexSoon();
			emit();
			return true;
		},

		// One sync at a time; a second call while one runs gets the same one.
		sync() {
			if (!syncing) {
				syncing = run().catch((err) => {
					lastError = err.message;
					log('[games] sync failed: ' + err.message);
					return status();
				}).finally(() => {
					syncing = null;
					emit();
				});
				emit();
			}
			return syncing;
		},

		get syncing() { return syncing; },

		status,
		gameReady,

		async clear() {
			if (syncing) await syncing.catch(() => {});
			index = emptyIndex();
			if (saveTimer) clearTimeout(saveTimer);
			saveTimer = null;
			await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
			lastError = null;
			progress = { done: 0, total: 0 };
			emit();
		},

		onChange(fn) {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},

		flush() { saveIndex(); }
	};
}

module.exports = {
	SITE, GAMES, PAGES, SEEDS, KEPT_HEADERS,
	isEligible, keyOf, gameOfKey, kindOf,
	namedInPage, namedInStylesheet, namedInScript, requiredBy,
	createBundle
};
