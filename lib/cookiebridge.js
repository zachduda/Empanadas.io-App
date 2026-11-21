'use strict';

// The games play in a session of their own (persist:play, where their files
// are served from disk - lib/gameprotocol.js), but save to the player's
// account, which is signed in in the app's main session. So the account's
// cookies are kept the same in both: everything the main session has is
// copied across before a game starts, and from then on a change on either
// side (the site rotating the session, a sign-out) is copied to the other.
//
// Only empanadas.io's cookies. Cloudflare's own (__cf_bm, cf_clearance) are
// left to each session: they belong to the connection, not the account.
//
// a and b are Electron Cookies objects (session.cookies), or anything with
// the same get/set/remove and 'changed' event.

const APP_HOST = 'empanadas.io';

function bareDomain(domain) {
	return String(domain || '').toLowerCase().replace(/^\./, '');
}

function isSiteCookie(cookie) {
	if (!cookie || typeof cookie.name !== 'string') return false;
	const domain = bareDomain(cookie.domain);
	if (domain !== APP_HOST && !domain.endsWith('.' + APP_HOST)) return false;
	const name = cookie.name.toLowerCase();
	return !name.startsWith('__cf') && !name.startsWith('cf_');
}

function cookieUrl(cookie) {
	return 'https://' + bareDomain(cookie.domain) + (cookie.path || '/');
}

// What cookies.set() takes to make the same cookie on the other side.
function setDetails(cookie) {
	const details = {
		url: cookieUrl(cookie),
		name: cookie.name,
		value: cookie.value,
		path: cookie.path || '/',
		secure: !!cookie.secure,
		httpOnly: !!cookie.httpOnly
	};
	// A host-only cookie has no Domain attribute; giving it one would widen it
	// to the subdomains.
	if (!cookie.hostOnly && cookie.domain) details.domain = cookie.domain;
	if (typeof cookie.expirationDate === 'number' && !cookie.session) details.expirationDate = cookie.expirationDate;
	if (cookie.sameSite && cookie.sameSite !== 'unspecified') details.sameSite = cookie.sameSite;
	return details;
}

function signature(cookie, removed) {
	return [removed ? '-' : '+', cookie.name, bareDomain(cookie.domain), cookie.path || '/', removed ? '' : cookie.value].join('|');
}

// Causes Electron gives a removal the other side should copy: removed on
// purpose (signing out deletes the cookies), or replaced by an expired one
// (the site's way of deleting a cookie).
const REMOVALS = new Set(['explicit', 'expired-overwrite', 'expired_overwrite']);

function createCookieBridge(a, b, { log = () => {} } = {}) {
	// Changes this bridge made itself, so the event they raise on the other
	// side is not copied straight back.
	const echoes = new Map([[a, new Set()], [b, new Set()]]);
	const listeners = [];

	async function copy(cookie, removed, to) {
		const sig = signature(cookie, removed);
		echoes.get(to).add(sig);
		try {
			if (removed) {
				await to.remove(cookieUrl(cookie), cookie.name);
			} else {
				await to.set(setDetails(cookie));
			}
		} catch (err) {
			echoes.get(to).delete(sig);
			log('[cookies] could not copy ' + cookie.name + ': ' + err.message);
		}
	}

	function watch(from, to) {
		const listener = (_event, cookie, cause, removed) => {
			if (!isSiteCookie(cookie)) return;
			const sig = signature(cookie, removed);
			if (echoes.get(from).delete(sig)) return;
			// An overwrite is reported as the old one going and the new one
			// arriving: the arrival is copied, the going is not.
			if (removed && !REMOVALS.has(cause)) return;
			copy(cookie, removed, to);
		};
		from.on('changed', listener);
		listeners.push(() => from.removeListener('changed', listener));
	}

	return {
		// Makes b's site cookies the same as a's: copies a's, and removes
		// those b has that a does not.
		async syncAtoB() {
			const [mine, theirs] = await Promise.all([a.get({}), b.get({})]);
			const wanted = mine.filter(isSiteCookie);
			const key = (c) => c.name + '|' + bareDomain(c.domain) + '|' + (c.path || '/');
			const have = new Map(theirs.filter(isSiteCookie).map((c) => [key(c), c]));
			const jobs = [];
			for (const cookie of wanted) {
				const there = have.get(key(cookie));
				have.delete(key(cookie));
				if (!there || there.value !== cookie.value) jobs.push(copy(cookie, false, b));
			}
			for (const extra of have.values()) jobs.push(copy(extra, true, b));
			await Promise.all(jobs);
		},
		start() {
			if (listeners.length) return;
			watch(a, b);
			watch(b, a);
		},
		stop() {
			while (listeners.length) listeners.pop()();
		}
	};
}

// Removes the account's cookies from a session (signing out), leaving
// Cloudflare's.
async function clearSiteCookies(cookies) {
	const all = await cookies.get({});
	await Promise.all(all.filter(isSiteCookie).map((cookie) =>
		cookies.remove(cookieUrl(cookie), cookie.name).catch(() => {})));
}

module.exports = { isSiteCookie, cookieUrl, setDetails, createCookieBridge, clearSiteCookies };
