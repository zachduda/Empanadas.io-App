'use strict';

// The desktop app's native requests to empanadas.io.
//
// The screens are the app's own, drawn from the site's JSON API for native
// apps - /v2/ios/*, which despite the name answers any app that brings a
// signed-in session: it checks the session cookie and the user agent it was
// signed in with, nothing else. Every answer is JSON, errors included:
//
//     { "ok": true,  "api": 1, ... }
//     { "ok": false, "api": 1, "reason": "no_session" }
//
// Changes go through /v2/account_edit.php, the handler the website itself
// uses, with the csrf token those answers hand out; save points through
// /v2/gamehistory.php; announcements come from the public api.empanadas.io.
// The same requests as the iOS app (ios/Empanadas/Core/AccountAPI.swift).
//
// Runs in the main process only. The pages of the app never see a cookie or
// a token: they ask for a screen's data over IPC and get the answer back.
//
// fetch(url, init) is injected - Electron's session.fetch() in the app, a
// fake in the tests - and must return a WHATWG Response.

const SITE = 'https://empanadas.io';
const API = 'https://api.empanadas.io';

const TIMEOUT = 15 * 1000;
const MAX_BODY = 4 * 1024 * 1024;

const MESSAGES = {
	signed_out: "You've been signed out.",
	needs_captcha: 'Please complete a quick check on the website first.',
	rate_limited: "That's a lot of changes at once. Try again in a minute.",
	stale_token: 'Your session needs refreshing. Try again.',
	network: "Couldn't reach Empanadas.io. Check your connection.",
	invalid: "That didn't look right. Try again."
};

class ApiError extends Error {
	constructor(code, message) {
		super(message || MESSAGES[code] || 'Something went wrong on our end. Try again!');
		this.name = 'ApiError';
		this.code = code;
	}
}

function unavailable(detail) {
	return new ApiError('unavailable', detail
		? "This couldn't be loaded (" + detail + ').'
		: "This couldn't be loaded.");
}

function serverError(status) {
	return new ApiError('server', 'Empanadas.io is having trouble right now (error ' + status + '). Try again in a bit.');
}

function formBody(fields) {
	const params = new URLSearchParams();
	for (const [name, value] of fields) params.append(name, String(value));
	return params.toString();
}

function stripTags(text) {
	return String(text || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function parseJson(text) {
	try {
		return JSON.parse(text);
	} catch (err) {
		return null;
	}
}

// A player's id as the site gives it (ab12cd34-...), or 32 hex digits without
// the dashes. account_edit.php takes the latter.
function rawPlayerId(id) {
	if (typeof id !== 'string') return null;
	const raw = id.replace(/-/g, '').toLowerCase();
	return /^[0-9a-f]{32}$/.test(raw) ? raw : null;
}

function isPlayerId(id) {
	return rawPlayerId(id) !== null && /^[0-9a-fA-F-]{32,36}$/.test(id);
}

// What a search sends: the site takes 2 to 16 characters (iosSearchTerm()).
function searchTerm(text) {
	const term = String(text || '').replace(/\s+/g, ' ').trim();
	return term.length >= 2 && term.length <= 16 ? term : null;
}

// One line, at most the 200 characters the site keeps, as the web's bio box
// sends it.
function bioLine(text) {
	return String(text || '').split(/\r\n|\r|\n/).join(' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

// account_edit.php says "csrf" when the settings token is stale, and
// CSRF_FAIL_MSG for the friend and bio changes.
function isStaleToken(reason) {
	return reason === 'csrf' || String(reason || '').startsWith('Your request has expired or was invalid');
}

// The body of a successful /v2/ios/ answer, or the error it stands for. A 404
// that is not our JSON is a site without the endpoint; a 5xx that is not, the
// server (or Cloudflare in front of it) failing.
function iosBody(text, status) {
	const reply = parseJson(text);
	if (!reply || typeof reply !== 'object' || typeof reply.ok !== 'boolean') {
		if (status === 429) throw new ApiError('rate_limited');
		if (status >= 500 && status <= 599) throw serverError(status);
		throw unavailable('HTTP ' + status);
	}
	if (reply.ok) return reply;
	if (reply.reason === 'no_session') throw new ApiError('signed_out');
	if (reply.reason === 'invalid_search') throw new ApiError('invalid', 'Search for 2 to 16 letters or numbers.');
	throw unavailable(reply.reason || 'HTTP ' + status);
}

// The save points' answers: {"result": Bool, "reason": String?}.
const SAVE_POINT_REASONS = {
	not_found: "That save point couldn't be found.",
	reset: "That save point is from before an anti-cheat reset, so it can't be restored.",
	locked: 'Your account is locked, so its game data can\'t be changed right now.',
	empty: 'That save point has nothing in it to restore.'
};

function gameHistoryBody(text, status) {
	const reply = parseJson(text);
	if (!reply || typeof reply !== 'object' || typeof reply.result !== 'boolean') {
		if (status === 429) throw new ApiError('rate_limited');
		if (status >= 500 && status <= 599) throw serverError(status);
		throw unavailable('HTTP ' + status);
	}
	if (reply.result) return reply;
	const reason = String(reply.reason || '');
	if (reason === 'no_session') throw new ApiError('signed_out');
	if (reason === 'csrf') throw new ApiError('stale_token');
	if (reason === 'cooldown') {
		const wait = Math.max(1, Number(reply.wait) || 30);
		throw new ApiError('server', 'You can restore once every 30 seconds. Try again in ' + wait + ' second' + (wait === 1 ? '' : 's') + '.');
	}
	throw new ApiError('server', SAVE_POINT_REASONS[reason] || (reason ? stripTags(reason) : undefined));
}

function createApi({ fetch, userAgent = () => '', onSignedOut = () => {} }) {
	let token = null;

	async function send(url, { method = 'GET', form = null, credentials = 'include', timeout = TIMEOUT } = {}) {
		const headers = { Accept: 'application/json, text/plain, */*' };
		const ua = userAgent();
		if (ua) headers['User-Agent'] = ua;
		const init = { method, headers, cache: 'no-store', redirect: 'follow', credentials };
		if (form) {
			headers['Content-Type'] = 'application/x-www-form-urlencoded';
			init.body = formBody(form);
		}

		const attempt = async () => {
			const abort = new AbortController();
			const timer = setTimeout(() => abort.abort(), timeout);
			try {
				const res = await fetch(url, Object.assign({}, init, { signal: abort.signal }));
				const buffer = Buffer.from(await res.arrayBuffer());
				if (buffer.length > MAX_BODY) throw new ApiError('server', 'That answer was too big.');
				return { status: res.status, text: buffer.toString('utf8') };
			} finally {
				clearTimeout(timer);
			}
		};

		try {
			return await attempt();
		} catch (err) {
			if (err instanceof ApiError) throw err;
			// A request that changes nothing is tried once more: just after
			// launch or waking, the connection is often still coming up.
			if (method === 'GET' && !(err && err.name === 'AbortError')) {
				await new Promise((resolve) => setTimeout(resolve, 1500));
				try {
					return await attempt();
				} catch (again) {
					if (again instanceof ApiError) throw again;
				}
			}
			throw new ApiError('network');
		}
	}

	function remember(csrf) {
		if (typeof csrf === 'string' && csrf) token = csrf;
	}

	async function iosGet(path, query) {
		const url = new URL(SITE + path);
		for (const [name, value] of Object.entries(query || {})) {
			if (value !== undefined && value !== null && value !== '') url.searchParams.set(name, String(value));
		}
		const { status, text } = await send(url.href);
		try {
			const body = iosBody(text, status);
			remember(body.csrf);
			return body;
		} catch (err) {
			if (err.code === 'signed_out') onSignedOut();
			throw err;
		}
	}

	async function account() {
		return iosGet('/v2/ios/account.php');
	}

	// Runs a change with the session's token: the one last seen, else a fresh
	// one. The site clears its token after a mismatch (a web page issued a
	// new one meanwhile), so on that the change is tried once more.
	async function withToken(body) {
		let csrf = token;
		if (!csrf) csrf = (await account()).csrf;
		try {
			return await body(csrf);
		} catch (err) {
			if (!(err instanceof ApiError) || err.code !== 'stale_token') throw err;
			token = null;
			const fresh = (await account()).csrf;
			return body(fresh);
		}
	}

	// POST /v2/account_edit.php, the handler behind every change on the
	// account page.
	async function change(action, fields, csrf) {
		const { status, text } = await send(SITE + '/v2/account_edit.php', {
			method: 'POST',
			form: [['account_change', action], ...fields, ['csrf', csrf]]
		});
		if (status === 429) throw new ApiError('rate_limited');
		if (status !== 200) throw new ApiError('server', 'Error ' + status);
		const reply = parseJson(text) || {};
		if (Number(reply.result) === 1) return reply;
		const reason = typeof reply.reason === 'string' ? reply.reason : '';
		if (reason === 'no_session') {
			onSignedOut();
			throw new ApiError('signed_out');
		}
		if (reason === 'needs_captcha') throw new ApiError('needs_captcha');
		if (isStaleToken(reason)) throw new ApiError('stale_token');
		throw new ApiError('server', stripTags(reason) || undefined);
	}

	function playerField(id) {
		const raw = rawPlayerId(id);
		if (!raw) throw new ApiError('invalid', "That player couldn't be found.");
		return raw;
	}

	return {
		account,
		dashboard: () => iosGet('/v2/ios/dashboard.php'),
		leaderboard: () => iosGet('/v2/ios/leaderboard.php'),

		profile(id) {
			if (id === undefined || id === null || id === '') return iosGet('/v2/ios/profile.php');
			if (!isPlayerId(id)) return Promise.reject(new ApiError('invalid', "That player couldn't be found."));
			return iosGet('/v2/ios/profile.php', { id: String(id).toLowerCase() });
		},

		search(text, page = 0) {
			const q = searchTerm(text);
			if (!q) return Promise.resolve({ ok: true, query: String(text || ''), page: 0, has_more: false, results: [] });
			const p = Math.max(0, Math.min(50, Math.floor(Number(page) || 0)));
			return iosGet('/v2/ios/search.php', { q, p: p || undefined });
		},

		feedbackForm: () => iosGet('/v2/ios/feedback.php'),

		sendFeedback({ subject, message, wantsReply }) {
			const text = String(message || '').trim();
			const s = Math.floor(Number(subject));
			if (!Number.isFinite(s) || s < 0) return Promise.reject(new ApiError('invalid', 'Pick what your feedback is about.'));
			return withToken((csrf) => change('feedback', [
				['s', s], ['m', text], ['nr', wantsReply ? 1 : 0], ['sso', 0]
			], csrf));
		},

		addFriend: (id) => withToken((csrf) => change('add_friend', [['uuid', playerField(id)]], csrf)),
		answerFriend: (id, accept) => withToken((csrf) =>
			change('pending_friend', [['uuid', playerField(id)], ['r', accept ? 1 : 0]], csrf)),
		// Unfriends, or takes back a request: whatever is between the two.
		removeFriend: (id) => withToken((csrf) => change('delete_friend', [['uuid', playerField(id)], ['r', 0]], csrf)),
		updateBio: (text) => withToken((csrf) => change('bio', [['m', bioLine(text)]], csrf)),

		// One account_change=settings write, as the account page sends it.
		updateSetting(field, value) {
			if (!/^[a-z]{2,24}$/.test(String(field))) return Promise.reject(new ApiError('invalid'));
			const v = Math.floor(Number(value));
			if (!Number.isFinite(v) || v < 0 || v > 9) return Promise.reject(new ApiError('invalid'));
			return withToken((csrf) => change('settings', [[field, v]], csrf));
		},

		// The site checks the typed phrase (DELETE) itself.
		deleteAccount: (confirmation) => withToken((csrf) =>
			change('delete_account', [['cp', String(confirmation || '')]], csrf)),

		async savePoints(before) {
			const url = new URL(SITE + '/v2/gamehistory.php');
			const id = Math.floor(Number(before));
			if (id > 0) url.searchParams.set('before', String(id));
			const { status, text } = await send(url.href);
			return gameHistoryBody(text, status);
		},

		restoreSavePoint(id) {
			const n = Math.floor(Number(id));
			if (!(n > 0)) return Promise.reject(new ApiError('invalid'));
			return withToken(async (csrf) => {
				const { status, text } = await send(SITE + '/v2/gamehistory.php', {
					method: 'POST', form: [['id', n], ['csrf', csrf]]
				});
				return gameHistoryBody(text, status);
			});
		},

		// One announcement, the request the site's Updates page makes. Public,
		// so it goes without the session's cookies.
		async announcement({ page = 0, id = null, fresh = false } = {}) {
			const url = new URL(API + '/v1/updates.php');
			url.searchParams.set('v', '1');
			url.searchParams.set('page', String(Math.max(0, Math.floor(Number(page) || 0))));
			if (id && /^[A-Za-z0-9_-]{1,32}$/.test(String(id))) url.searchParams.set('post', String(id));
			if (fresh) url.searchParams.set('sc', String(Date.now()));
			const { status, text } = await send(url.href, { credentials: 'omit' });
			if (status !== 200) throw unavailable('HTTP ' + status);
			const reply = parseJson(text);
			if (!reply || typeof reply !== 'object') throw unavailable('unexpected reply');
			return reply;
		},

		// POST /v2/ios/signin.php: signs this session in with the code a
		// sign-in in the browser came back with, and the verifier of the
		// request it was for. The site sets the signed-in session's cookies.
		async redeemSignIn(code, verifier) {
			const { status, text } = await send(SITE + '/v2/ios/signin.php', {
				method: 'POST', form: [['code', code], ['verifier', verifier]]
			});
			if (status === 429) throw new ApiError('rate_limited', "That's a lot of tries. Wait a minute and try again.");
			const reply = parseJson(text);
			if (!reply || typeof reply.ok !== 'boolean') throw new ApiError('server', 'Something went wrong on our end (HTTP ' + status + '). Try again!');
			if (!reply.ok) {
				const reason = String(reply.reason || '');
				const messages = {
					expired: 'That sign-in took too long or was already used. Try again.',
					deactivated: "That account was deleted. Contact us if you'd like it back.",
					unavailable: 'Accounts are switched off right now. Try again later.'
				};
				throw new ApiError(reason === 'expired' ? 'expired' : 'server',
					messages[reason] || 'Something went wrong on our end (' + (reason || status) + '). Try again!');
			}
			token = null;
			return reply;
		},

		// Does the site still consider this session signed in? null when it
		// could not be asked.
		async isSignedIn() {
			try {
				const { status, text } = await send(SITE + '/v2/getdata.php?type=session');
				if (status !== 200) return null;
				const body = text.trim();
				if (body === '1') return true;
				if (body === 'no_session') return false;
				return null;
			} catch (err) {
				return null;
			}
		},

		async ping() {
			try {
				const { status, text } = await send(SITE + '/v2/ping.php?usingnativeapp=1&_=' + Date.now(), { timeout: 8000 });
				const ok = status >= 200 && status < 300;
				return { ok, status, pong: ok && text.trim().slice(0, 64) === 'Pong!' };
			} catch (err) {
				return { ok: false, status: 0, pong: false };
			}
		},

		// Ends the session on the site. Whatever the answer, the app forgets
		// it too (main.js clears the cookies).
		async signOut() {
			token = null;
			try {
				const { status } = await send(SITE + '/v2/auth/logout.php', { timeout: 8000 });
				return status > 0 && status < 500;
			} catch (err) {
				return false;
			}
		},

		forgetToken() { token = null; },
		get hasToken() { return !!token; }
	};
}

module.exports = {
	SITE, API, ApiError, createApi,
	formBody, stripTags, rawPlayerId, isPlayerId, searchTerm, bioLine, isStaleToken, iosBody, gameHistoryBody
};
