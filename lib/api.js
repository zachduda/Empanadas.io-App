'use strict';

const crypto = require('crypto');
const dme2ee = require('./dme2ee');

// The desktop app's native requests to empanadas.io.
//
// The screens are the app's own, drawn from the site's JSON API for the
// native apps, /v2/app/*, which the iOS app uses too: it checks the session
// cookie and the user agent it was signed in with, nothing else. Every answer
// is JSON, errors included:
//
//     { "ok": true,  "api": 1, ... }
//     { "ok": false, "api": 1, "reason": "no_session" }
//
// Changes go through /v2/account_edit.php, the handler the website itself
// uses, with the csrf token those answers hand out (direct messages through
// /v2/app/messages.php, with the same token); save points through
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

// The native API, and where it was before the desktop app used it too. The
// site answers at both (each /v2/ios/ file is an alias); the old address is
// only used against a site that does not have the new one yet, so this app
// works whichever is deployed first.
const NATIVE_API = '/v2/app/';
const OLD_NATIVE_API = '/v2/ios/';
// How long the old address is used, once the site turned out not to have the
// new one, before the new one is tried again.
const OLD_API_RECHECK = 60 * 60 * 1000;

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

// Is this the native API's own answer ({"ok": Bool, ...}), as opposed to
// nginx's 404 page or a proxy's?
function isNativeReply(text) {
	const reply = parseJson(text);
	return !!reply && typeof reply === 'object' && typeof reply.ok === 'boolean';
}

// The body of a successful /v2/app/ answer, or the error it stands for. A 404
// that is not our JSON is a site without the endpoint; a 5xx that is not, the
// server (or Cloudflare in front of it) failing.
function nativeBody(text, status) {
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

// A daily reward claim's answer (/v2/app/daily.php). A day already claimed
// (on the website, another device) is not an error: it pays nothing and
// carries the reward as it stands.
function dailyClaimBody(text, status) {
	const reply = parseJson(text);
	const reason = reply && typeof reply === 'object' ? reply.reason : null;
	if (reason === 'csrf') throw new ApiError('stale_token');
	if (reason === 'review') throw new ApiError('server', "This is a demo account for App Review, so rewards aren't saved.");
	if (reason === 'claimed' && reply.daily && typeof reply.daily === 'object') {
		return { granted: 0, peppers: null, daily: reply.daily };
	}
	const body = nativeBody(text, status);
	if (!body.daily || typeof body.daily !== 'object') throw unavailable('unexpected reply');
	return { granted: Number(body.granted) || 0, peppers: Number.isFinite(body.peppers) ? body.peppers : null, daily: body.daily };
}

// Direct messages (/v2/app/messages.php): what each refusal means, for the
// screens to show and switch on (the error's code is the site's reason).
const MESSAGE_REASONS = {
	not_friends: 'You can only message friends.',
	blocked: "You blocked them. Unblock them to send a message.",
	unavailable: "You can't message them right now.",
	unverified: 'Verify your email address to send messages.',
	rate_limited: "You're sending messages too quickly. Wait a minute and try again.",
	too_long: 'That message is too long.',
	empty: 'Type a message first.',
	not_found: "That couldn't be found.",
	self: "You can't message yourself.",
	no_keys: "They haven't set up encrypted messages yet. They need to open Messages on the website or an updated app first.",
	keys_changed: 'Their devices changed. Try again.',
	too_late: "Messages can only be edited for a minute after they're sent.",
	deleted: 'That message was deleted.',
	encryption_required: 'Update Empanadas.io to send messages.'
};

// What a message the site can't read says when this computer can't read it either.
const SEALED_TEXT = '\u{1F512} Can\'t be read on this computer';
const DELETED_TEXT = 'Message deleted';

// The most a message holds; the site says so with each answer (max_length).
const MESSAGE_MAX = 1000;

// A message as the site will keep it, for checking before it is sent: the
// site tidies it the same way (dmBody() in v2/_messages.php) and has the last
// word.
function messageText(text) {
	return String(text === undefined || text === null ? '' : text)
		.replace(/\r\n?/g, '\n').replace(/\t/g, ' ').replace(/[ \u00a0]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// The device's id for one message: a retry under the same one is the same
// message to the site.
function isMessageNonce(nonce) {
	return typeof nonce === 'string' && /^[A-Za-z0-9_-]{8,32}$/.test(nonce);
}

function messageId(id) {
	const n = Number(id);
	return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

// An answer of /v2/app/messages.php: the body, or an ApiError whose code is
// the site's reason (stale_token for csrf, signed_out for no_session).
function messagesBody(text, status) {
	const reply = parseJson(text);
	if (!reply || typeof reply !== 'object' || typeof reply.ok !== 'boolean') return nativeBody(text, status);
	if (reply.ok) return reply;
	const reason = String(reply.reason || '');
	if (reason === 'no_session') throw new ApiError('signed_out');
	if (reason === 'csrf') throw new ApiError('stale_token');
	if (MESSAGE_REASONS[reason]) {
		const message = reason === 'too_long'
			? 'That message is too long. Keep it under ' + (Number(reply.max_length) || MESSAGE_MAX).toLocaleString('en-US') + ' characters.'
			: MESSAGE_REASONS[reason];
		const error = new ApiError(reason, message);
		if (reply.keys) error.keys = reply.keys;
		throw error;
	}
	if (status >= 500 && status <= 599) throw serverError(status);
	throw unavailable(reason || 'HTTP ' + status);
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

// dmKeys: lib/dmkeys.js's store, for this computer's message key.
function createApi({ fetch, userAgent = () => '', onSignedOut = () => {}, now = () => Date.now(), dmKeys = null }) {
	let token = null;
	// This computer's key for the signed-in account, made and handed to the site once.
	let deviceKey = null;
	let deviceAccount = null;
	// Each conversation's devices, from its last answer, to seal the next message for.
	const conversationKeys = new Map();
	// Messages already opened, by id and edit.
	const opened = new Map();
	// Until when the old address of the native API is used (see NATIVE_API).
	let oldApiUntil = 0;

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

	// One request to the native API, by endpoint name ("dashboard.php"). At
	// /v2/app/, or at /v2/ios/ when the site has answered a plain 404 for
	// /v2/app/ (a site from before the move): then for OLD_API_RECHECK. Safe
	// for a POST too: a path the site does not have changed nothing.
	async function sendNative(name, query, opts) {
		const urlAt = (base) => {
			const url = new URL(SITE + base + name);
			for (const [key, value] of Object.entries(query || {})) {
				if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
			}
			return url.href;
		};
		if (now() < oldApiUntil) return send(urlAt(OLD_NATIVE_API), opts);
		const reply = await send(urlAt(NATIVE_API), opts);
		if (reply.status !== 404 || isNativeReply(reply.text)) return reply;
		const old = await send(urlAt(OLD_NATIVE_API), opts);
		if (old.status !== 404 || isNativeReply(old.text)) oldApiUntil = now() + OLD_API_RECHECK;
		return old;
	}

	async function nativeGet(name, query) {
		const { status, text } = await sendNative(name, query);
		try {
			const body = nativeBody(text, status);
			remember(body.csrf);
			return body;
		} catch (err) {
			if (err.code === 'signed_out') onSignedOut();
			throw err;
		}
	}

	async function account() {
		return nativeGet('account.php');
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

	async function messagesGet(query) {
		const { status, text } = await sendNative('messages.php', query);
		try {
			const body = messagesBody(text, status);
			remember(body.csrf);
			return body;
		} catch (err) {
			if (err.code === 'signed_out') onSignedOut();
			throw err;
		}
	}

	async function ownKey() {
		const account = await accountId();
		if (deviceKey && deviceAccount === account) return deviceKey;
		deviceAccount = account;
		deviceKey = (async () => {
			let kept = dmKeys ? dmKeys.load(account) : null;
			let key = null;
			if (kept) {
				try {
					key = { privateKey: await dme2ee.importPrivate(kept.jwk), publicKey: kept.publicKey, device: kept.device };
				} catch (err) {
					key = null;
				}
			}
			if (!key) {
				key = await dme2ee.newDeviceKey(true);
				if (dmKeys) dmKeys.save(account, { jwk: await dme2ee.exportPrivate(key.privateKey), publicKey: key.publicKey, device: key.device });
			}
			await messagesPost([['action', 'register_key'], ['public_key', key.publicKey]]);
			return key;
		})();
		deviceKey.catch(() => { deviceKey = null; });
		return deviceKey;
	}

	let accountIdPromise = null;
	function accountId() {
		if (!accountIdPromise) {
			accountIdPromise = account().then((body) => {
				const id = body && body.account && body.account.id;
				if (!id) throw unavailable('no account id');
				return String(id);
			});
			accountIdPromise.catch(() => { accountIdPromise = null; });
		}
		return accountIdPromise;
	}

	// The words of a message, opened here: the site only ever has the envelope.
	async function reveal(m, key) {
		if (!m || typeof m !== 'object') return m;
		if (m.deleted) {
			m.text = DELETED_TEXT;
		} else if (typeof m.cipher === 'string') {
			const cacheKey = m.id + ':' + (m.edited || 0);
			if (!opened.has(cacheKey)) {
				let out = { text: SEALED_TEXT, sealed: true };
				if (key) {
					try { out = { text: await dme2ee.open(m.cipher, key), sealed: false }; } catch (err) { /* sealed */ }
				}
				opened.set(cacheKey, out);
			}
			Object.assign(m, opened.get(cacheKey));
			m.encrypted = true;
		}
		delete m.cipher;
		return m;
	}

	async function keyOrNull() {
		try { return await ownKey(); } catch (err) { return null; }
	}

	const hasCipher = (list) => list.some((m) => m && typeof m.cipher === 'string');

	async function revealThread(body, playerRaw) {
		const key = hasCipher([].concat(body.messages || [], body.changed || [])) ? await keyOrNull() : null;
		if (body.keys) conversationKeys.set(playerRaw, body.keys);
		for (const m of [].concat(body.messages || [], body.changed || [])) await reveal(m, key);
		delete body.keys;
		return body;
	}

	async function revealInbox(body) {
		const key = hasCipher((Array.isArray(body.conversations) ? body.conversations : []).map((c) => c && c.last)) ? await keyOrNull() : null;
		for (const c of Array.isArray(body.conversations) ? body.conversations : []) {
			const last = c && c.last;
			if (!last) continue;
			if (last.deleted) last.preview = DELETED_TEXT;
			else if (typeof last.cipher === 'string') {
				await reveal(last, key);
				last.preview = last.sealed ? '\u{1F512} Encrypted message' : String(last.text).replace(/\s+/g, ' ').trim();
				delete last.text;
			}
			delete last.cipher;
		}
		return body;
	}

	// Sealed for both players' devices (and this one), again for the fresh list if a device is new.
	async function sealedPost(playerRaw, text, fields) {
		const key = await ownKey();
		let keys = conversationKeys.get(playerRaw);
		if (!keys) {
			const fresh = await messagesGet({ with: playerRaw, after: Number.MAX_SAFE_INTEGER });
			keys = fresh.keys;
			conversationKeys.set(playerRaw, keys);
		}
		for (let attempt = 0; ; attempt++) {
			const all = [].concat((keys && keys.mine) || [], (keys && keys.theirs) || [], [{ device: key.device, key: key.publicKey }]);
			let cipher;
			try {
				cipher = await dme2ee.seal(text, all);
			} catch (err) {
				throw new ApiError('no_keys', MESSAGE_REASONS.no_keys);
			}
			try {
				return await messagesPost([...fields, ['cipher', cipher]]);
			} catch (err) {
				if (!(err instanceof ApiError) || err.code !== 'keys_changed' || !err.keys || attempt > 0) throw err;
				keys = err.keys;
				conversationKeys.set(playerRaw, keys);
			}
		}
	}

	function messagesPost(fields) {
		return withToken(async (csrf) => {
			const { status, text } = await sendNative('messages.php', null, { method: 'POST', form: [...fields, ['csrf', csrf]] });
			try {
				return messagesBody(text, status);
			} catch (err) {
				if (err.code === 'signed_out') onSignedOut();
				throw err;
			}
		});
	}

	return {
		account,
		dashboard: () => nativeGet('dashboard.php'),
		leaderboard: () => nativeGet('leaderboard.php'),

		profile(id) {
			if (id === undefined || id === null || id === '') return nativeGet('profile.php');
			if (!isPlayerId(id)) return Promise.reject(new ApiError('invalid', "That player couldn't be found."));
			return nativeGet('profile.php', { id: String(id).toLowerCase() });
		},

		search(text, page = 0) {
			const q = searchTerm(text);
			if (!q) return Promise.resolve({ ok: true, query: String(text || ''), page: 0, has_more: false, results: [] });
			const p = Math.max(0, Math.min(50, Math.floor(Number(page) || 0)));
			return nativeGet('search.php', { q, p: p || undefined });
		},

		feedbackForm: () => nativeGet('feedback.php'),

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

		// POST /v2/app/daily.php: claims today's daily reward. Its status
		// comes with the dashboard ("daily").
		claimDailyReward() {
			return withToken(async (csrf) => {
				const { status, text } = await sendNative('daily.php', null, { method: 'POST', form: [['csrf', csrf]] });
				try {
					return dailyClaimBody(text, status);
				} catch (err) {
					if (err.code === 'signed_out') onSignedOut();
					throw err;
				}
			});
		},

		// Direct messages, from /v2/app/messages.php: the inbox, and one
		// conversation (the newest page, the one before message `before`, or
		// only what is newer than `after`).
		conversations: async () => revealInbox(await messagesGet({})),

		// since: the last answer's `now`, so a poll also hands back what was edited or deleted.
		async thread(id, { before, after, since } = {}) {
			const raw = playerField(id);
			const body = await messagesGet({ with: raw, before: messageId(before) || undefined, after: messageId(after) || undefined,
				since: messageId(since) || undefined });
			return revealThread(body, raw);
		},

		// The nonce is the screen's id for this message, kept across its
		// retries so the site stores it once; without one, one is made.
		async sendMessage(id, text, nonce) {
			const body = messageText(text);
			if (!body) throw new ApiError('empty', MESSAGE_REASONS.empty);
			if (body.length > MESSAGE_MAX * 2) throw new ApiError('too_long', MESSAGE_REASONS.too_long);
			const to = playerField(id);
			const n = isMessageNonce(nonce) ? nonce : crypto.randomBytes(16).toString('hex');
			const reply = await sealedPost(to, body, [['action', 'send'], ['to', to], ['nonce', n]]);
			if (reply.message) {
				opened.set(reply.message.id + ':0', { text: body, sealed: false });
				await reveal(reply.message, null);
			}
			return reply;
		},

		// Within a minute of sending it (the site says until when: editable_until).
		async editMessage(id, message, text) {
			const n = messageId(message);
			if (!n) throw new ApiError('invalid');
			const body = messageText(text);
			if (!body) throw new ApiError('empty', MESSAGE_REASONS.empty);
			const reply = await sealedPost(playerField(id), body, [['action', 'edit'], ['message', n]]);
			if (reply.message) {
				opened.set(reply.message.id + ':' + (reply.message.edited || 0), { text: body, sealed: false });
				await reveal(reply.message, null);
			}
			return reply;
		},

		async deleteMessage(message) {
			const n = messageId(message);
			if (!n) throw new ApiError('invalid');
			const reply = await messagesPost([['action', 'delete'], ['message', n]]);
			if (reply.message) await reveal(reply.message, null);
			return reply;
		},

		// Registers this computer's key with the site, as signing in does.
		prepareMessages: () => ownKey().then(() => ({ ready: true })),

		// Marks what they sent up to message upTo (all of it without one) read.
		async readMessages(id, upTo) {
			const fields = [['action', 'read'], ['with', playerField(id)]];
			if (messageId(upTo)) fields.push(['up_to', messageId(upTo)]);
			return messagesPost(fields);
		},

		blockPlayer: async (id, block) => messagesPost([['action', block ? 'block' : 'unblock'], ['with', playerField(id)]]),

		// text: the message as this computer opened it, since the site can't read it.
		async reportMessage(id, reason, note, text = '') {
			const n = messageId(id);
			if (!n) throw new ApiError('invalid');
			const why = ['spam', 'harassment', 'inappropriate', 'other'].includes(reason) ? reason : 'other';
			return messagesPost([['action', 'report'], ['message', n], ['reason', why], ['note', messageText(note).slice(0, 500)],
				['text', messageText(text).slice(0, MESSAGE_MAX)]]);
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

		// POST /v2/app/signin.php: signs this session in with the code a
		// sign-in in the browser came back with, and the verifier of the
		// request it was for. The site sets the signed-in session's cookies.
		async redeemSignIn(code, verifier) {
			const { status, text } = await sendNative('signin.php', null, {
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

		// Signed out, or another account in: its token, key and conversations go.
		forgetToken() {
			token = null;
			deviceKey = null;
			deviceAccount = null;
			accountIdPromise = null;
			conversationKeys.clear();
			opened.clear();
		},
		get hasToken() { return !!token; },
		// Which address of the native API is in use (the old one only against a
		// site from before the move).
		get nativeApi() { return now() < oldApiUntil ? OLD_NATIVE_API : NATIVE_API; }
	};
}

module.exports = {
	SITE, API, NATIVE_API, OLD_NATIVE_API, OLD_API_RECHECK, MESSAGE_MAX, ApiError, createApi,
	formBody, stripTags, rawPlayerId, isPlayerId, searchTerm, bioLine, isStaleToken, isNativeReply, nativeBody, gameHistoryBody, dailyClaimBody,
	messageText, isMessageNonce, messagesBody
};
