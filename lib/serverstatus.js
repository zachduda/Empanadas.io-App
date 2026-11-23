'use strict';

// The site's server status, as the Server Status card on its Updates page
// shows it (checkSiteStatus() in the site's _core.js) and the iOS app's
// Settings does (ios/Empanadas/Core/ServerStatus.swift): the overall
// indicator from Statuspage's public API, cached for a minute as the site
// caches it.
//
// Asked for by the main process, not the screens: their content security
// policy keeps them off the network.
//
// Plain Node: fetch is injected, as in lib/gamebundle.js.

// Where the full status page is.
const PAGE = 'https://empanadas.statuspage.io/';
// The same endpoint the site reads.
const API = 'https://9c0yt9mrrj7l.statuspage.io/api/v2/status.json';
// How long an answer is good for: the site caches it for a minute.
const MAX_AGE = 60 * 1000;
const TIMEOUT = 10 * 1000;

// Statuspage's `status.indicator`, in the words the screens use.
const LEVELS = { none: 'operational', minor: 'minor', major: 'major', critical: 'critical' };

// A third-party answer, so nothing about its shape is assumed.
function levelOf(body) {
	const indicator = body && typeof body === 'object' && body.status && typeof body.status === 'object'
		? body.status.indicator : null;
	return Object.prototype.hasOwnProperty.call(LEVELS, indicator) ? LEVELS[indicator] : 'unknown';
}

function createServerStatus({ fetch, now = Date.now, maxAge = MAX_AGE }) {
	let state = { level: 'checking', checkedAt: 0 };
	let inFlight = null;

	async function ask() {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), TIMEOUT);
		try {
			const res = await fetch(API, {
				headers: { Accept: 'application/json' }, cache: 'no-store', signal: controller.signal
			});
			if (!res || res.status !== 200) return { level: 'unknown', checkedAt: 0 };
			let body = null;
			try {
				body = await res.json();
			} catch (err) {
				body = null;
			}
			return { level: levelOf(body), checkedAt: now() };
		} catch (err) {
			return { level: 'unknown', checkedAt: 0 };
		} finally {
			clearTimeout(timer);
		}
	}

	// The last answer while it is under a minute old (and was an answer);
	// otherwise Statuspage is asked again. One question at a time.
	function get(force = false) {
		const fresh = state.level !== 'unknown' && state.checkedAt && now() - state.checkedAt < maxAge;
		if (!force && fresh) return Promise.resolve(Object.assign({}, state));
		if (!inFlight) {
			inFlight = ask().then((next) => {
				state = next;
				inFlight = null;
				return Object.assign({}, state);
			});
		}
		return inFlight;
	}

	return { get, current: () => Object.assign({}, state) };
}

module.exports = { createServerStatus, levelOf, PAGE, API, MAX_AGE };
