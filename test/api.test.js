'use strict';

// lib/api.js, lib/signin.js and lib/answers.js: the native screens' requests
// to the site, the browser sign-in's PKCE half, and the answers kept for
// offline. None of it needs Electron: the requests go through a fake fetch.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const api = require('../lib/api');
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
	assert.deepStrictEqual(api.iosBody('{"ok":true,"api":1,"x":2}', 200), { ok: true, api: 1, x: 2 });
});

check('no_session is a sign-out, other reasons say what went wrong', () => {
	assert.throws(() => api.iosBody('{"ok":false,"reason":"no_session"}', 401), (e) => e.code === 'signed_out');
	assert.throws(() => api.iosBody('{"ok":false,"reason":"not_found"}', 404), (e) => e.code === 'unavailable' && /not_found/.test(e.message));
});

check('an answer that is not the site\'s JSON is a missing endpoint or a failing server', () => {
	assert.throws(() => api.iosBody('<html>', 404), (e) => e.code === 'unavailable' && /404/.test(e.message));
	assert.throws(() => api.iosBody('<html>', 502), (e) => e.code === 'server' && /502/.test(e.message));
	assert.throws(() => api.iosBody('', 429), (e) => e.code === 'rate_limited');
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
	const site = fakeFetch([['https://empanadas.io/v2/ios/dashboard.php', () => json({ ok: true, api: 1, spin: {} })]]);
	const client = api.createApi({ fetch: site.fetch, userAgent: () => 'Test empanadas.io/9.9.9' });
	await client.dashboard();
	assert.strictEqual(site.calls[0].init.headers['User-Agent'], 'Test empanadas.io/9.9.9');
	assert.strictEqual(site.calls[0].init.cache, 'no-store');
	assert.strictEqual(site.calls[0].init.credentials, 'include');
});

check('a signed-out answer tells the app', async () => {
	let told = 0;
	const site = fakeFetch([[/ios\/account/, () => json({ ok: false, api: 1, reason: 'no_session' }, 401)]]);
	const client = api.createApi({ fetch: site.fetch, onSignedOut: () => told++ });
	await assert.rejects(client.account(), (e) => e.code === 'signed_out');
	assert.strictEqual(told, 1);
});

check('a change goes to account_edit.php with the token, and once more with a fresh one if stale', async () => {
	let tokens = 0;
	const posted = [];
	const site = fakeFetch([
		[/ios\/account/, () => json({ ok: true, api: 1, account: { username: 'x' }, csrf: 'token' + (++tokens) })],
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
		[/ios\/account/, () => json({ ok: true, api: 1, csrf: 't' })],
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
	const site = fakeFetch([[/ios\/signin\.php/, (url, init) => {
		const form = new URLSearchParams(init.body);
		if (form.get('verifier') !== 'right') return json({ ok: false, api: 1, reason: 'expired' }, 400);
		return json({ ok: true, api: 1, account: { username: 'tester' } });
	}]]);
	const client = api.createApi({ fetch: site.fetch });
	assert.strictEqual((await client.redeemSignIn('c'.repeat(40), 'right')).account.username, 'tester');
	await assert.rejects(client.redeemSignIn('c'.repeat(40), 'wrong'), (e) => e.code === 'expired');
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

Promise.all(pending).then(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
	if (failures.length) {
		console.error('\n' + failures.length + ' api test(s) failed');
		process.exit(1);
	}
});
