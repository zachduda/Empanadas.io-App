'use strict';

// What answers the games' requests: the handler main.js gives
// protocol.handle('https') in the games' own session (persist:play), and only
// there - the app's own screens, the API and the site's account pages are in
// another session, which goes to the network as any browser does.
//
//  - A file the bundle keeps (lib/gamebundle.js) comes from disk, under the
//    address the game asked for: https://empanadas.io/spin is still the
//    site's origin, with its localStorage and cookies.
//  - Anything else goes to the network, unchanged: the saves
//    (/v2/getdata.php, /v2/updatedata.php), the clock on api.empanadas.io,
//    analytics. A static file it finds there that the bundle did not know is
//    kept for next time.
//  - When the network is known to be down (the computer says it is offline,
//    or a request just failed), the network gets NETWORK_TIMEOUT to answer
//    rather than the minute a dead connection can take, so a game opened
//    offline starts from this computer's save at once. The same rule as the
//    site's own offline worker (html/sw.js).
//
// passThrough(request, signal) is injected: session.fetch() with
// bypassCustomProtocolHandlers in the app, a fake in the tests.

const fs = require('fs');

const NETWORK_TIMEOUT = 4000;
const DOWN_FOR = 15000;

// "bytes=start-end", "bytes=start-" or "bytes=-suffix", for one range.
function parseRange(header, size) {
	const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
	if (!match || (match[1] === '' && match[2] === '')) return null;
	let start;
	let end;
	if (match[1] === '') {
		const suffix = Number(match[2]);
		if (!suffix) return 'unsatisfiable';
		start = Math.max(0, size - suffix);
		end = size - 1;
	} else {
		start = Number(match[1]);
		end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
	}
	if (start >= size || start > end) return 'unsatisfiable';
	return { start, end };
}

async function readSlice(file, start, length) {
	const handle = await fs.promises.open(file, 'r');
	try {
		const buffer = Buffer.alloc(length);
		let read = 0;
		while (read < length) {
			const { bytesRead } = await handle.read(buffer, read, length - read, start + read);
			if (!bytesRead) break;
			read += bytesRead;
		}
		return buffer.subarray(0, read);
	} finally {
		await handle.close();
	}
}

// A kept file, as an answer: its own headers, and a part of it when the
// request asks for one (audio elements do).
async function serveEntry(entry, request) {
	let size = entry.size;
	try {
		size = (await fs.promises.stat(entry.path)).size;
	} catch (err) {
		return null;
	}
	const headers = new Headers();
	for (const [name, value] of Object.entries(entry.headers || {})) headers.set(name, value);
	if (!headers.has('content-type') && entry.type) headers.set('content-type', entry.type);
	headers.set('accept-ranges', 'bytes');
	// The copy on disk is what is current; nothing should cache it as well.
	headers.set('cache-control', 'no-cache');
	headers.set('x-empanadas-app', 'local');

	const head = request.method === 'HEAD';
	const range = request.headers.get('range') ? parseRange(request.headers.get('range'), size) : null;
	if (range === 'unsatisfiable') {
		headers.set('content-range', 'bytes */' + size);
		return new Response(null, { status: 416, headers });
	}
	if (range) {
		const length = range.end - range.start + 1;
		headers.set('content-range', 'bytes ' + range.start + '-' + range.end + '/' + size);
		headers.set('content-length', String(length));
		return new Response(head ? null : await readSlice(entry.path, range.start, length), { status: 206, headers });
	}
	headers.set('content-length', String(size));
	return new Response(head ? null : await fs.promises.readFile(entry.path), { status: 200, headers });
}

function createGameHandler({ bundle, passThrough, online = () => true, now = () => Date.now(), log = () => {} }) {
	let downUntil = 0;

	const networkDown = () => !online() || now() < downUntil;
	const markDown = () => { downUntil = now() + DOWN_FOR; };
	const markUp = () => { downUntil = 0; };

	async function forward(request) {
		const down = networkDown();
		const abort = new AbortController();
		const timer = down ? setTimeout(() => abort.abort(), NETWORK_TIMEOUT) : null;
		let res;
		try {
			res = await passThrough(request, abort.signal);
		} catch (err) {
			markDown();
			return Response.error();
		} finally {
			if (timer) clearTimeout(timer);
		}
		markUp();
		if (request.method === 'GET' && res.status === 200 && bundle.isEligible(request.url)) {
			let copy = null;
			try {
				copy = res.clone();
			} catch (err) {
				copy = null;
			}
			if (copy) bundle.learn(request.url, copy).catch((err) => log('[games] could not keep ' + request.url + ': ' + err.message));
		}
		return res;
	}

	return async function handle(request) {
		if (request.method === 'GET' || request.method === 'HEAD') {
			const entry = bundle.lookup(request.url);
			if (entry) {
				try {
					const res = await serveEntry(entry, request);
					if (res) return res;
				} catch (err) {
					log('[games] could not read ' + request.url + ': ' + err.message);
				}
			}
		}
		return forward(request);
	};
}

module.exports = { NETWORK_TIMEOUT, DOWN_FOR, parseRange, serveEntry, createGameHandler };
