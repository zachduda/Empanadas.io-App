'use strict';

// Profile pictures and the site's other pictures the app's screens show,
// kept on disk so they draw at once and without a connection. The screens
// never load them from the site themselves: they ask for
// app://img/?u=<address>, and this answers from disk when the copy is less
// than a day old, from the site otherwise, and from the old copy when the
// site cannot be reached.
//
// Only pictures, only from empanadas.io and its subdomains: this must not
// become a way for a page to fetch anything it likes.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_AGE = 24 * 60 * 60 * 1000;
const MAX_SIZE = 8 * 1024 * 1024;
const SITE = 'https://empanadas.io';

// A picture's address as the site gives it ("/pfp/lg/x.png", or a full URL),
// made absolute, or null when it is not one this may fetch.
function pictureUrl(value) {
	if (typeof value !== 'string' || !value || value.length > 2048) return null;
	let url;
	try {
		url = new URL(value, SITE);
	} catch (err) {
		return null;
	}
	if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
	const host = url.hostname.toLowerCase();
	if (host !== 'empanadas.io' && !host.endsWith('.empanadas.io')) return null;
	url.hash = '';
	return url.href;
}

function createImageCache({ dir, fetch, userAgent = () => '', now = () => Date.now() }) {
	const inFlight = new Map();
	const fileOf = (url) => path.join(dir, crypto.createHash('sha256').update(url).digest('hex'));

	async function readKept(url) {
		const base = fileOf(url);
		try {
			const meta = JSON.parse(await fs.promises.readFile(base + '.json', 'utf8'));
			const body = await fs.promises.readFile(base + '.bin');
			return { body, type: meta.type, fetchedAt: meta.fetchedAt };
		} catch (err) {
			return null;
		}
	}

	async function fetchAndKeep(url) {
		const headers = { Accept: 'image/avif,image/webp,image/png,image/*;q=0.8' };
		const ua = userAgent();
		if (ua) headers['User-Agent'] = ua;
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), 15000);
		try {
			const res = await fetch(url, { headers, credentials: 'omit', cache: 'no-store', signal: abort.signal });
			const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
			if (res.status !== 200 || !type.startsWith('image/')) return null;
			const body = Buffer.from(await res.arrayBuffer());
			if (!body.length || body.length > MAX_SIZE) return null;
			const base = fileOf(url);
			await fs.promises.mkdir(dir, { recursive: true });
			await fs.promises.writeFile(base + '.bin', body);
			await fs.promises.writeFile(base + '.json', JSON.stringify({ type, fetchedAt: now(), url }));
			return { body, type, fetchedAt: now() };
		} catch (err) {
			return null;
		} finally {
			clearTimeout(timer);
		}
	}

	return {
		// { body, type } or null.
		async get(value, { fresh = false } = {}) {
			const url = pictureUrl(value);
			if (!url) return null;
			const kept = await readKept(url);
			if (kept && !fresh && now() - kept.fetchedAt < MAX_AGE) return kept;
			if (!inFlight.has(url)) {
				inFlight.set(url, fetchAndKeep(url).finally(() => inFlight.delete(url)));
			}
			return (await inFlight.get(url)) || kept;
		},

		async clear() {
			await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
		},

		async size() {
			let total = 0;
			try {
				for (const name of await fs.promises.readdir(dir)) {
					total += (await fs.promises.stat(path.join(dir, name))).size;
				}
			} catch (err) {
				// Nothing kept.
			}
			return total;
		}
	};
}

module.exports = { pictureUrl, createImageCache };
