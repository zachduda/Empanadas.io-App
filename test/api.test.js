'use strict';

// lib/api.js, lib/signin.js and lib/answers.js: the native screens' requests
// to the site, the browser sign-in's PKCE half, and the answers kept for
// offline. None of it needs Electron: the requests go through a fake fetch.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const api = require('../lib/api');
const dme2ee = require('../lib/dme2ee');
const signin = require('../lib/signin');
const { createAnswers, withoutToken } = require('../lib/answers');

const failures = [];
const pending = [];

function check(what, fn) {
	const pass = () => console.log('  ok    ' + what);
	const fail = (err) => {
		failures.push(what + ': ' + err.message);
		console.log('  FAIL  ' + what + ' - ' + err.message);
	};
	try {
		const result = fn();
		if (result && typeof result.then === 'function') pending.push(result.then(pass, fail));
		else pass();
	} catch (err) {
		fail(err);
	}
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'empanadas-api-'));

function json(body, status = 200) {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// A fake site: routes is a list of [matcher, handler(url, init)].
function fakeFetch(routes) {
	const calls = [];
	const fetch = async (url, init = {}) => {
		calls.push({ url, init });
		for (const [match, handler] of routes) {
			if (typeof match === 'string' ? url.startsWith(match) : match.test(url)) return handler(url, init, calls);
		}
		return new Response('<html>404</html>', { status: 404 });
	};
	return { fetch, calls };
}

// --- PKCE -------------------------------------------------------------

check('the challenge is base64url(SHA-256(verifier)) (RFC 7636 appendix B)', () => {
	assert.strictEqual(signin.challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
		'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

check('a verifier is 43 URL-safe characters, and new each time', () => {
	const a = signin.makeVerifier();
	const b = signin.makeVerifier();
	assert.match(a, /^[A-Za-z0-9_-]{43}$/);
	assert.notStrictEqual(a, b);
});

check('the browser starts at /v2/auth/app.php with the challenge and the mode', () => {
	const request = signin.createRequest('create', { verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk' });
	const url = new URL(request.url);
	assert.strictEqual(url.origin + url.pathname, 'https://empanadas.io/v2/auth/app.php');
	assert.strictEqual(url.searchParams.get('challenge'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
	assert.strictEqual(url.searchParams.get('mode'), 'create');
	assert.strictEqual(new URL(signin.createRequest('anything').url).searchParams.get('mode'), 'login');
});

check('only a well-formed empanadas-io://signin link gives up a code', () => {
	const code = 'a'.repeat(40);
	assert.strictEqual(signin.signInCode('empanadas-io://signin?code=' + code), code);
	assert.strictEqual(signin.signInCode('empanadas-io://signin/?code=' + code), code);
	assert.strictEqual(signin.signInCode('empanadas-io://signin?code=short'), null);
	assert.strictEqual(signin.signInCode('empanadas-io://signin?code=' + 'a'.repeat(39) + '%3C'), null);
	assert.strictEqual(signin.signInCode('empanadas-io://signin/extra?code=' + code), null);
	assert.strictEqual(signin.signInCode('empanadas-io://auth?code=' + code), null);
	assert.strictEqual(signin.signInCode('https://signin?code=' + code), null);
	assert.strictEqual(signin.signInCode(42), null);
});

check('a sign-in under way survives a restart, for the TTL and no longer', () => {
	const file = path.join(tmp, 'pending.json');
	const store = signin.createPendingStore(file);
	const started = store.start('login', 1000);
	assert.ok(fs.existsSync(file));
	const again = signin.createPendingStore(file);
	// Read back with the real clock, so give it a fresh start time.
	assert.strictEqual(again.get(1000 + 1), null, 'a request from the epoch is long expired');
	const live = signin.createPendingStore(file);
	const now = Date.now();
	const fresh = live.start('create', now);
	const reread = signin.createPendingStore(file).get(now + 1000);
	assert.ok(reread, 'not read back');
	assert.strictEqual(reread.verifier, fresh.verifier);
	assert.strictEqual(reread.challenge, signin.challengeFor(fresh.verifier));
	assert.strictEqual(reread.mode, 'create');
	assert.strictEqual(live.get(now + signin.SIGNIN_TTL + 1), null, 'kept past the TTL');
	assert.ok(!fs.existsSync(file), 'the expired request is still on disk');
	assert.ok(started.verifier);
});

check('clearing a sign-in removes it from disk', () => {
	const file = path.join(tmp, 'pending2.json');
	const store = signin.createPendingStore(file);
	store.start('login');
	store.clear();
	assert.strictEqual(store.get(), null);
	assert.ok(!fs.existsSync(file));
});

// --- parsing ----------------------------------------------------------

check('an ok answer is returned whole', () => {
	assert.deepStrictEqual(api.nativeBody('{"ok":true,"api":1,"x":2}', 200), { ok: true, api: 1, x: 2 });
});

check('no_session is a sign-out, other reasons say what went wrong', () => {
	assert.throws(() => api.nativeBody('{"ok":false,"reason":"no_session"}', 401), (e) => e.code === 'signed_out');
	assert.throws(() => api.nativeBody('{"ok":false,"reason":"not_found"}', 404), (e) => e.code === 'unavailable' && /not_found/.test(e.message));
});

check('an answer that is not the site\'s JSON is a missing endpoint or a failing server', () => {
	assert.throws(() => api.nativeBody('<html>', 404), (e) => e.code === 'unavailable' && /404/.test(e.message));
	assert.throws(() => api.nativeBody('<html>', 502), (e) => e.code === 'server' && /502/.test(e.message));
	assert.throws(() => api.nativeBody('', 429), (e) => e.code === 'rate_limited');
});

check('player ids are 32 hex digits, with or without dashes', () => {
	assert.strictEqual(api.rawPlayerId('AB12CD34-0000-1111-2222-333344445555'), 'ab12cd34000011112222333344445555');
	assert.strictEqual(api.rawPlayerId('ab12cd34000011112222333344445555'), 'ab12cd34000011112222333344445555');
	assert.strictEqual(api.rawPlayerId('../../etc'), null);
	assert.strictEqual(api.rawPlayerId('ab12'), null);
	assert.ok(!api.isPlayerId('ab12cd34-0000-1111-2222-33334444555g'));
});

check('a bio is one line of at most 200 characters', () => {
	assert.strictEqual(api.bioLine('  hello\r\nthere\nfriend  '), 'hello there friend');
	assert.strictEqual(api.bioLine('x'.repeat(300)).length, 200);
});

check('a search is 2 to 16 characters', () => {
	assert.strictEqual(api.searchTerm(' a '), null);
	assert.strictEqual(api.searchTerm('  em  pa '), 'em pa');
	assert.strictEqual(api.searchTerm('x'.repeat(17)), null);
});

check('save point reasons become sentences', () => {
	assert.throws(() => api.gameHistoryBody('{"result":false,"reason":"cooldown","wait":12}', 200), /12 seconds/);
	assert.throws(() => api.gameHistoryBody('{"result":false,"reason":"no_session"}', 200), (e) => e.code === 'signed_out');
	assert.strictEqual(api.gameHistoryBody('{"result":true,"rows":[]}', 200).result, true);
});

// --- requests ---------------------------------------------------------

check('requests carry the app\'s user agent and never a cached answer', async () => {
	const site = fakeFetch([['https://empanadas.io/v2/app/dashboard.php', () => json({ ok: true, api: 1, spin: {} })]]);
	const client = api.createApi({ fetch: site.fetch, userAgent: () => 'Test empanadas.io/9.9.9' });
	await client.dashboard();
	assert.strictEqual(site.calls[0].init.headers['User-Agent'], 'Test empanadas.io/9.9.9');
	assert.strictEqual(site.calls[0].init.cache, 'no-store');
	assert.strictEqual(site.calls[0].init.credentials, 'include');
});

check('a signed-out answer tells the app', async () => {
	let told = 0;
	const site = fakeFetch([[/v2\/app\/account/, () => json({ ok: false, api: 1, reason: 'no_session' }, 401)]]);
	const client = api.createApi({ fetch: site.fetch, onSignedOut: () => told++ });
	await assert.rejects(client.account(), (e) => e.code === 'signed_out');
	assert.strictEqual(told, 1);
});

check('a change goes to account_edit.php with the token, and once more with a fresh one if stale', async () => {
	let tokens = 0;
	const posted = [];
	const site = fakeFetch([
		[/v2\/app\/account/, () => json({ ok: true, api: 1, account: { username: 'x' }, csrf: 'token' + (++tokens) })],
		[/account_edit\.php/, (url, init) => {
			const form = new URLSearchParams(init.body);
			posted.push(Object.fromEntries(form));
			return form.get('csrf') === 'token1' ? json({ result: 0, reason: 'csrf' }) : json({ result: 1 });
		}]
	]);
	const client = api.createApi({ fetch: site.fetch });
	await client.addFriend('AB12CD34-0000-1111-2222-333344445555');
	assert.strictEqual(posted.length, 2);
	assert.deepStrictEqual(posted[0], { account_change: 'add_friend', uuid: 'ab12cd34000011112222333344445555', csrf: 'token1' });
	assert.strictEqual(posted[1].csrf, 'token2');
	assert.strictEqual(site.calls[1].init.headers['Content-Type'], 'application/x-www-form-urlencoded');
	// The token is kept: the next change asks for no new one.
	await client.updateBio('hi\nthere');
	assert.strictEqual(tokens, 2);
	assert.deepStrictEqual(posted[2], { account_change: 'bio', m: 'hi there', csrf: 'token2' });
});

check('a refused change says why, without the site\'s markup', async () => {
	const site = fakeFetch([
		[/v2\/app\/account/, () => json({ ok: true, api: 1, csrf: 't' })],
		[/account_edit\.php/, () => json({ result: 0, reason: '<b>Verify</b> your email first.' })]
	]);
	const client = api.createApi({ fetch: site.fetch });
	await assert.rejects(client.updateBio('x'), (e) => e.code === 'server' && e.message === 'Verify your email first.');
});

check('a bad player id is refused before anything is sent', async () => {
	const site = fakeFetch([]);
	const client = api.createApi({ fetch: site.fetch });
	await assert.rejects(client.profile('../etc/passwd'), (e) => e.code === 'invalid');
	await assert.rejects(client.removeFriend('nope'), (e) => e.code === 'invalid' || e.code === 'unavailable');
	assert.ok(site.calls.every((c) => !/account_edit/.test(c.url)));
});

check('a short search asks the site nothing', async () => {
	const site = fakeFetch([]);
	const client = api.createApi({ fetch: site.fetch });
	const reply = await client.search('a');
	assert.deepStrictEqual(reply.results, []);
	assert.strictEqual(site.calls.length, 0);
});

check('a GET that fails before an answer is tried once more; a POST is not', async () => {
	let gets = 0;
	let posts = 0;
	const fetch = async (url, init) => {
		if (init.method === 'POST') { posts++; throw new TypeError('fetch failed'); }
		gets++;
		if (gets === 1) throw new TypeError('fetch failed');
		return json({ ok: true, api: 1, spin: [] });
	};
	const client = api.createApi({ fetch });
	await client.leaderboard();
	assert.strictEqual(gets, 2);
	await assert.rejects(client.redeemSignIn('a'.repeat(40), 'v'), (e) => e.code === 'network');
	assert.strictEqual(posts, 1);
});

check('redeeming a sign-in posts the code and the verifier', async () => {
	const site = fakeFetch([[/v2\/app\/signin\.php/, (url, init) => {
		const form = new URLSearchParams(init.body);
		if (form.get('verifier') !== 'right') return json({ ok: false, api: 1, reason: 'expired' }, 400);
		return json({ ok: true, api: 1, account: { username: 'tester' } });
	}]]);
	const client = api.createApi({ fetch: site.fetch });
	assert.strictEqual((await client.redeemSignIn('c'.repeat(40), 'right')).account.username, 'tester');
	await assert.rejects(client.redeemSignIn('c'.repeat(40), 'wrong'), (e) => e.code === 'expired');
});

check('the native API is asked for at /v2/app/', async () => {
	const site = fakeFetch([[/./, (url) => json({ ok: true, api: 1, url })]]);
	const client = api.createApi({ fetch: site.fetch });
	await client.dashboard();
	await client.profile('ab12cd34-0000-1111-2222-333344445555');
	await client.search('spin', 2);
	assert.deepStrictEqual(site.calls.map((c) => new URL(c.url).pathname),
		['/v2/app/dashboard.php', '/v2/app/profile.php', '/v2/app/search.php']);
	assert.strictEqual(new URL(site.calls[2].url).search, '?q=spin&p=2');
	assert.strictEqual(client.nativeApi, '/v2/app/');
});

check('against a site from before the move, the old address is used, then the new one tried again later', async () => {
	let clock = 1000;
	let moved = false;
	const site = fakeFetch([
		[/\/v2\/app\//, () => moved ? json({ ok: true, api: 1, at: 'app' }) : new Response('<html>404 Not Found</html>', { status: 404 })],
		[/\/v2\/ios\//, () => json({ ok: true, api: 1, at: 'ios' })]
	]);
	const client = api.createApi({ fetch: site.fetch, now: () => clock });
	assert.strictEqual((await client.dashboard()).at, 'ios');
	assert.strictEqual(client.nativeApi, '/v2/ios/');
	site.calls.length = 0;
	assert.strictEqual((await client.leaderboard()).at, 'ios');
	assert.deepStrictEqual(site.calls.map((c) => new URL(c.url).pathname), ['/v2/ios/leaderboard.php'], 'asked /v2/app/ again straight away');
	moved = true;
	clock += api.OLD_API_RECHECK + 1;
	assert.strictEqual((await client.dashboard()).at, 'app');
	assert.strictEqual(client.nativeApi, '/v2/app/');
});

check('the API\'s own 404 is an answer, not a missing endpoint', async () => {
	const site = fakeFetch([[/./, () => json({ ok: false, api: 1, reason: 'not_found' }, 404)]]);
	const client = api.createApi({ fetch: site.fetch });
	await assert.rejects(client.profile('ab12cd34-0000-1111-2222-333344445555'), (e) => e.code === 'unavailable' && /not_found/.test(e.message));
	assert.strictEqual(site.calls.length, 1, 'asked the old address over a real answer');
	assert.strictEqual(client.nativeApi, '/v2/app/');
});

check('a site with neither address says so, and keeps trying the new one', async () => {
	const site = fakeFetch([]);
	const client = api.createApi({ fetch: site.fetch });
	await assert.rejects(client.dashboard(), (e) => e.code === 'unavailable' && /404/.test(e.message));
	assert.strictEqual(client.nativeApi, '/v2/app/');
});

check('signing in falls back to the old address too, with the same code', async () => {
	const site = fakeFetch([[/\/v2\/ios\/signin\.php/, (url, init) => {
		const form = new URLSearchParams(init.body);
		return json({ ok: true, api: 1, account: { username: form.get('code') === 'c'.repeat(40) ? 'tester' : '?' } });
	}]]);
	const client = api.createApi({ fetch: site.fetch });
	assert.strictEqual((await client.redeemSignIn('c'.repeat(40), 'v')).account.username, 'tester');
	assert.deepStrictEqual(site.calls.map((c) => new URL(c.url).pathname), ['/v2/app/signin.php', '/v2/ios/signin.php']);
	assert.ok(site.calls.every((c) => c.init.method === 'POST'));
});

check('announcements are asked for without cookies', async () => {
	const site = fakeFetch([['https://api.empanadas.io/v1/updates.php', () => json({ found: true, id: 'abc123', page: 0, total: 3 })]]);
	const client = api.createApi({ fetch: site.fetch });
	const reply = await client.announcement({ page: 2, id: 'abc123' });
	assert.strictEqual(reply.id, 'abc123');
	const url = new URL(site.calls[0].url);
	assert.strictEqual(url.searchParams.get('page'), '2');
	assert.strictEqual(url.searchParams.get('post'), 'abc123');
	assert.strictEqual(site.calls[0].init.credentials, 'omit');
});

check('isSignedIn() is null when the site could not be asked', async () => {
	const down = api.createApi({ fetch: async () => { throw new TypeError('down'); } });
	assert.strictEqual(await down.isSignedIn(), null);
	const site = fakeFetch([[/getdata\.php\?type=session/, () => new Response('no_session')]]);
	assert.strictEqual(await api.createApi({ fetch: site.fetch }).isSignedIn(), false);
});

// --- answers kept for offline ----------------------------------------

check('answers are kept on disk without their token, and go at sign-out', () => {
	const dir = path.join(tmp, 'answers');
	let clock = 5000;
	const answers = createAnswers(dir, { now: () => clock });
	assert.ok(answers.save('account', { ok: true, csrf: 'secret', account: { username: 'a' } }));
	const reread = createAnswers(dir).load('account');
	assert.strictEqual(reread.savedAt, 5000);
	assert.strictEqual(reread.body.csrf, '');
	assert.strictEqual(reread.body.account.username, 'a');
	assert.ok(!answers.save('cookies', { x: 1 }), 'saved a key it does not know');
	answers.clear();
	assert.strictEqual(createAnswers(dir).load('account'), null);
	clock++;
});

check('an answer from before a sign-out is not written back', () => {
	const answers = createAnswers(path.join(tmp, 'answers2'));
	const started = answers.generation;
	answers.clear();
	assert.ok(!answers.save('dashboard', { ok: true }, started));
	assert.strictEqual(answers.load('dashboard'), null);
	assert.deepStrictEqual(withoutToken([1, 2]), [1, 2]);
});

check('a daily reward claim pays, or says it was already claimed', () => {
	const daily = { claimed: true, streak: 5, day: 5, week: [] };
	const paid = api.dailyClaimBody(JSON.stringify({ ok: true, api: 1, granted: 10, peppers: 138, daily }), 200);
	assert.deepStrictEqual(paid, { granted: 10, peppers: 138, daily });
	const again = api.dailyClaimBody(JSON.stringify({ ok: false, api: 1, reason: 'claimed', daily }), 409);
	assert.deepStrictEqual(again, { granted: 0, peppers: null, daily });
	assert.throws(() => api.dailyClaimBody('{"ok":false,"api":1,"reason":"csrf"}', 403), (e) => e.code === 'stale_token');
	assert.throws(() => api.dailyClaimBody('{"ok":false,"api":1,"reason":"no_session"}', 401), (e) => e.code === 'signed_out');
	assert.throws(() => api.dailyClaimBody('{"ok":false,"api":1,"reason":"review"}', 403), /demo account/);
	assert.throws(() => api.dailyClaimBody('<html>', 404), (e) => e.code === 'unavailable');
});

// --- direct messages -------------------------------------------------------

check('the inbox and a conversation are read from messages.php, and hand over the token', async () => {
	const site = fakeFetch([[/v2\/app\/messages\.php/, (url) => json({ ok: true, api: 1, url, conversations: [], messages: [], csrf: 'msg-token' })]]);
	const client = api.createApi({ fetch: site.fetch });
	await client.conversations();
	assert.strictEqual(site.calls[0].url, 'https://empanadas.io/v2/app/messages.php');
	await client.thread('AB12CD34-0000-1111-2222-333344445555');
	assert.strictEqual(site.calls[1].url, 'https://empanadas.io/v2/app/messages.php?with=ab12cd34000011112222333344445555');
	await client.thread('ab12cd34000011112222333344445555', { before: 40 });
	assert.ok(site.calls[2].url.endsWith('&before=40'));
	await client.thread('ab12cd34000011112222333344445555', { after: '41', before: 'nope' });
	assert.ok(site.calls[3].url.endsWith('with=ab12cd34000011112222333344445555&after=41'));
	assert.ok(client.hasToken);
	await assert.rejects(client.thread('../x'), (e) => e.code === 'invalid');
	assert.strictEqual(site.calls.length, 4);
});

// A fake messages.php with one device for the other player, and the keys it was handed.
async function messagesSite({ stale = false, e2ee = true, turnedOnMeanwhile = false } = {}) {
	const state = { on: e2ee && !turnedOnMeanwhile };
	const theirs = await dme2ee.newDeviceKey(true);
	const later = await dme2ee.newDeviceKey(true);
	let tokens = 0;
	let refusedOnce = false;
	const posted = [];
	const registered = [];
	const keys = () => ({ mine: registered.map((k) => ({ device: k.device, key: k.key })), theirs: [{ device: theirs.device, key: theirs.publicKey }]
		.concat(stale && refusedOnce ? [{ device: later.device, key: later.publicKey }] : []) });
	const site = fakeFetch([
		[/v2\/app\/account/, () => json({ ok: true, api: 1, account: { id: 42 }, csrf: 'token' + (++tokens) })],
		[/v2\/app\/messages\.php/, async (url, init) => {
			if (!init.body) return json({ ok: true, api: 1, messages: [], keys: keys(), e2ee: { on: state.on, by: null }, now: 1000, csrf: 'token' + tokens });
			const form = Object.fromEntries(new URLSearchParams(init.body));
			posted.push(form);
			if (form.action === 'register_key') {
				registered.push({ key: form.public_key, device: await dme2ee.deviceId(form.public_key) });
				return json({ ok: true, api: 1, device: registered[registered.length - 1].device });
			}
			if (form.csrf === 'token1') return json({ ok: false, api: 1, reason: 'csrf' }, 403);
			if (form.action === 'e2ee') {
				state.on = form.on === '1';
				return json({ ok: true, api: 1, e2ee: { on: state.on, by: 'me' }, keys: keys() });
			}
			if (turnedOnMeanwhile && form.text) {
				state.on = true;
				return json({ ok: false, api: 1, reason: 'encryption_required', e2ee: { on: true, by: 'them' }, keys: keys() }, 409);
			}
			if (form.text) return json({ ok: true, api: 1, message: { id: 8, from_me: true, text: form.text, cipher: null, sent: 1 } });
			if (stale && !refusedOnce) {
				refusedOnce = true;
				return json({ ok: false, api: 1, reason: 'keys_changed', keys: keys() }, 409);
			}
			if (form.action === 'delete') return json({ ok: true, api: 1, message: { id: Number(form.message), from_me: true, text: 'This message was deleted.', cipher: null, deleted: true } });
			return json({ ok: true, api: 1, message: { id: Number(form.message) || 7, from_me: true, text: 'locked', cipher: form.cipher, sent: 1, read: false,
				edited: form.action === 'edit' ? 2 : null }, duplicate: false });
		}]
	]);
	const store = new Map();
	const dmKeys = { load: (a) => store.get(a) || null, save: (a, v) => store.set(a, v) };
	return { site, posted, theirs, later, store, client: api.createApi({ fetch: site.fetch, dmKeys }) };
}

check('a message is sealed for both players\' devices, posted with its nonce and the token, and once more with a fresh token if stale', async () => {
	const { posted, theirs, store, client } = await messagesSite();
	const reply = await client.sendMessage('AB12CD34-0000-1111-2222-333344445555', '  hey\r\n\r\n\r\nthere  ', 'nonce-abc123');
	assert.strictEqual(reply.message.text, 'hey\n\nthere');
	assert.strictEqual(reply.message.cipher, undefined, 'the screens never get the envelope');
	const sends = posted.filter((p) => p.action === 'send');
	assert.strictEqual(sends.length, 2);
	assert.strictEqual(sends[0].text, undefined, 'the words never go to the site');
	assert.strictEqual(await dme2ee.open(sends[0].cipher, theirs), 'hey\n\nthere');
	const mine = store.get('42');
	assert.ok(mine && mine.jwk && mine.device, 'this computer keeps its key');
	assert.strictEqual(await dme2ee.open(sends[0].cipher, { privateKey: await dme2ee.importPrivate(mine.jwk), publicKey: mine.publicKey, device: mine.device }), 'hey\n\nthere');
	assert.deepStrictEqual(Object.assign({}, sends[0], { cipher: '' }), { action: 'send', to: 'ab12cd34000011112222333344445555', nonce: 'nonce-abc123', csrf: 'token1', cipher: '' });
	// The retry is the same message: the same nonce.
	assert.strictEqual(sends[1].nonce, 'nonce-abc123');
	assert.strictEqual(sends[1].csrf, 'token2');
	await client.sendMessage('ab12cd34000011112222333344445555', 'again', 'bad nonce!');
	assert.ok(/^[0-9a-f]{32}$/.test(posted[posted.length - 1].nonce), 'a nonce that is not one is replaced');
	assert.strictEqual(posted.filter((p) => p.action === 'register_key').length, 1, 'the key is handed to the site once');
});

check('a device the site knows of and the app did not gets the message sealed again', async () => {
	const { posted, later, client } = await messagesSite({ stale: true });
	await client.sendMessage('ab12cd34000011112222333344445555', 'for every device', 'nonce-stale1');
	const sends = posted.filter((p) => p.action === 'send' && p.csrf !== 'token1');
	assert.strictEqual(sends.length, 2);
	await assert.rejects(dme2ee.open(sends[0].cipher, later), (e) => e.message === 'not_for_device');
	assert.strictEqual(await dme2ee.open(sends[1].cipher, later), 'for every device');
	assert.strictEqual(sends[1].nonce, sends[0].nonce);
});

check('a conversation that isn\'t encrypted sends plain text; one turned on meanwhile is sealed after all', async () => {
	const plain = await messagesSite({ e2ee: false });
	const sent = await plain.client.sendMessage('ab12cd34000011112222333344445555', 'just text', 'nonce-plain1');
	const form = plain.posted.find((p) => p.action === 'send' && p.csrf !== 'token1');
	assert.deepStrictEqual([form.text, form.cipher, sent.message.text], ['just text', undefined, 'just text']);
	const turned = await plain.client.setEncrypted('ab12cd34000011112222333344445555', true);
	assert.deepStrictEqual([turned.e2ee.on, turned.keys], [true, undefined]);
	await plain.client.sendMessage('ab12cd34000011112222333344445555', 'now sealed', 'nonce-plain2');
	assert.strictEqual(await dme2ee.open(plain.posted[plain.posted.length - 1].cipher, plain.theirs), 'now sealed');

	const raced = await messagesSite({ turnedOnMeanwhile: true });
	await raced.client.sendMessage('ab12cd34000011112222333344445555', 'raced', 'nonce-race01');
	const sends = raced.posted.filter((p) => p.action === 'send' && p.csrf !== 'token1');
	assert.deepStrictEqual([sends[0].text, sends[1].text], ['raced', undefined]);
	assert.strictEqual(await dme2ee.open(sends[1].cipher, raced.theirs), 'raced');
	assert.strictEqual(sends[1].nonce, sends[0].nonce);
});

check('an encrypted message stays encrypted when edited, even after the conversation is turned off', async () => {
	const { posted, theirs, client } = await messagesSite({ e2ee: false });
	await client.editMessage('ab12cd34000011112222333344445555', 5, 'still private', true);
	const edit = posted.find((p) => p.action === 'edit');
	assert.strictEqual(edit.text, undefined);
	assert.strictEqual(await dme2ee.open(edit.cipher, theirs), 'still private');
});

check('an inbox preview follows an edit, and a key the site forgot is handed over again', async () => {
	const theirs = await dme2ee.newDeviceKey(true);
	const store = new Map();
	let mine = null;
	let last = null;
	let registers = 0;
	const site = fakeFetch([
		[/v2\/app\/account/, () => json({ ok: true, api: 1, account: { id: 42 }, csrf: 't' })],
		[/v2\/app\/messages\.php/, async (url, init) => {
			if (init.body) {
				const form = Object.fromEntries(new URLSearchParams(init.body));
				if (form.action === 'register_key') { registers++; mine = { device: await dme2ee.deviceId(form.public_key), key: form.public_key }; }
				return json({ ok: true, api: 1 });
			}
			if (url.includes('with=')) return json({ ok: true, api: 1, messages: [], keys: { mine: [], theirs: [] }, csrf: 't' });
			return json({ ok: true, api: 1, conversations: [{ with: { id: 'x' }, last: { id: 3, cipher: last } }], csrf: 't' });
		}]
	]);
	const client = api.createApi({ fetch: site.fetch, dmKeys: { load: (a) => store.get(a) || null, save: (a, v) => store.set(a, v) } });
	await client.prepareMessages();
	last = await dme2ee.seal('before', [mine, { device: theirs.device, key: theirs.publicKey }]);
	assert.strictEqual((await client.conversations()).conversations[0].last.preview, 'before');
	last = await dme2ee.seal('after the edit', [mine]);
	assert.strictEqual((await client.conversations()).conversations[0].last.preview, 'after the edit');
	assert.strictEqual(registers, 1);
	await client.thread('ab12cd34000011112222333344445555');
	assert.strictEqual(registers, 2, 'the site listed none of this computer\'s keys');
});

check('a conversation is opened here; an edit is sealed again, and a delete has nothing in it', async () => {
	const { posted, client } = await messagesSite();
	const id = 'ab12cd34000011112222333344445555';
	const sent = await client.sendMessage(id, 'first try', 'nonce-edit01');
	const sealed = posted.find((p) => p.action === 'send').cipher;
	const edited = await client.editMessage(id, sent.message.id, 'second try');
	assert.strictEqual(edited.message.text, 'second try');
	assert.strictEqual(posted[posted.length - 1].action, 'edit');
	assert.strictEqual(posted[posted.length - 1].text, undefined);
	const removed = await client.deleteMessage(7);
	assert.deepStrictEqual([removed.message.deleted, removed.message.text], [true, 'Message deleted']);
	await assert.rejects(client.editMessage(id, 'x', 'hi'), (e) => e.code === 'invalid');
	const other = await dme2ee.newDeviceKey(true);
	// Read by another computer: its own sealed message opens, one for another device doesn't.
	const elsewhere = await dme2ee.seal('not for you', [{ device: other.device, key: other.publicKey }]);
	const reveal = api.createApi({ fetch: fakeFetch([
		[/v2\/app\/account/, () => json({ ok: true, api: 1, account: { id: 42 }, csrf: 't' })],
		[/v2\/app\/messages\.php/, (url, init) => init.body ? json({ ok: true, api: 1 })
			: json({ ok: true, api: 1, messages: [{ id: 1, cipher: sealed }, { id: 2, cipher: elsewhere }, { id: 3, text: 'from before' }], csrf: 't' })]
	]).fetch, dmKeys: { load: () => null, save: () => {} } });
	const body = await reveal.thread(id);
	assert.deepStrictEqual(body.messages.map((m) => [m.text, !!m.sealed]), [["\u{1F512} Can't be read on this computer", true],
		["\u{1F512} Can't be read on this computer", true], ['from before', false]]);
	assert.ok(body.messages.every((m) => m.cipher === undefined));
});

check('a message with nothing in it is refused before anything is sent', async () => {
	const site = fakeFetch([]);
	const client = api.createApi({ fetch: site.fetch });
	await assert.rejects(client.sendMessage('ab12cd34000011112222333344445555', ' \n\t '), (e) => e.code === 'empty');
	await assert.rejects(client.sendMessage('nope', 'hi'), (e) => e.code === 'invalid');
	await assert.rejects(client.reportMessage('x', 'spam'), (e) => e.code === 'invalid');
	assert.strictEqual(site.calls.length, 0);
});

check('read, block, unblock and report post what the site takes', async () => {
	const posted = [];
	const site = fakeFetch([
		[/v2\/app\/account/, () => json({ ok: true, api: 1, csrf: 't' })],
		[/v2\/app\/messages\.php/, (url, init) => {
			posted.push(Object.fromEntries(new URLSearchParams(init.body)));
			return json({ ok: true, api: 1, unread: 0 });
		}]
	]);
	const client = api.createApi({ fetch: site.fetch });
	const id = 'ab12cd34000011112222333344445555';
	await client.readMessages(id, 12);
	await client.readMessages(id);
	await client.blockPlayer(id, true);
	await client.blockPlayer(id, false);
	await client.reportMessage(99, 'harassment', 'not nice\r\n');
	await client.reportMessage('100', 'made-up');
	assert.deepStrictEqual(posted, [
		{ action: 'read', with: id, up_to: '12', csrf: 't' },
		{ action: 'read', with: id, csrf: 't' },
		{ action: 'block', with: id, csrf: 't' },
		{ action: 'unblock', with: id, csrf: 't' },
		{ action: 'report', message: '99', reason: 'harassment', note: 'not nice', text: '', csrf: 't' },
		{ action: 'report', message: '100', reason: 'other', note: '', text: '', csrf: 't' }
	]);
});

check('the site\'s reasons for a message become sentences the screen can switch on', () => {
	const refused = (reason, extra = {}, status = 403) => {
		try {
			api.messagesBody(JSON.stringify(Object.assign({ ok: false, api: 1, reason }, extra)), status);
		} catch (err) {
			return err;
		}
		throw new Error(reason + ' was not refused');
	};
	assert.strictEqual(refused('not_friends').code, 'not_friends');
	assert.strictEqual(refused('not_friends').message, 'You can only message friends.');
	assert.strictEqual(refused('unavailable').code, 'unavailable');
	assert.strictEqual(refused('unverified').code, 'unverified');
	assert.strictEqual(refused('rate_limited', {}, 429).code, 'rate_limited');
	assert.strictEqual(refused('too_long', { max_length: 1000 }, 400).message, 'That message is too long. Keep it under 1,000 characters.');
	assert.strictEqual(refused('csrf').code, 'stale_token');
	assert.strictEqual(refused('no_session', {}, 401).code, 'signed_out');
	assert.strictEqual(refused('server_error', {}, 500).code, 'server');
	assert.throws(() => api.messagesBody('<html>404</html>', 404), (e) => e.code === 'unavailable');
	assert.deepStrictEqual(api.messagesBody('{"ok":true,"api":1,"x":1}', 200), { ok: true, api: 1, x: 1 });
});

check('a message is tidied as the site tidies it', () => {
	assert.strictEqual(api.messageText('  a\r\nb\rc\t d  \n\n\n\ne  '), 'a\nb\nc  d\n\ne');
	assert.strictEqual(api.messageText(null), '');
	assert.strictEqual(api.messageText('<b>x</b> & y'), '<b>x</b> & y');
	assert.ok(api.isMessageNonce('a1b2c3d4'));
	assert.ok(!api.isMessageNonce('a1b2c3d'));
	assert.ok(!api.isMessageNonce('x'.repeat(33)));
	assert.strictEqual(api.MESSAGE_MAX, 1000);
});

Promise.all(pending).then(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
	if (failures.length) {
		console.error('\n' + failures.length + ' api test(s) failed');
		process.exit(1);
	}
});
