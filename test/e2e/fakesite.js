'use strict';

// A stand-in for empanadas.io and api.empanadas.io, for driving the whole
// app end to end (test/e2e/run.js). The games are the site's real files,
// served from a checkout of the Empanadas-io repo; the JSON API answers for
// one made-up account, with a session cookie as the real one.
//
// The sign-in is checked as the site checks it: a code is only handed out
// for a PKCE challenge (mint()), and only redeemed with the verifier that
// matches it.

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const resourcesLib = require('../../lib/resources');

const ME = '1a2b3c4d-0000-4000-8000-00000000c0de';
// The screens' contract the app speaks (SHELL_API in main.js): the site's
// copy of the screens for it is the one the over-the-air checks change.
const SHELL_API = Number(/const SHELL_API = (\d+);/.exec(fs.readFileSync(path.join(__dirname, '..', '..', 'main.js'), 'utf8'))[1]);
const FRIENDS = [
	['ab12cd34-1111-4111-8111-111111111111', 'SpinQueen', 'online', 'Online'],
	['ab12cd34-2222-4222-8222-222222222222', 'FlappyFan', 'away', 'Active 4m ago'],
	['ab12cd34-3333-4333-8333-333333333333', 'TowerTom', 'offline', 'Active 2d ago']
];

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function history(days) {
	const out = [];
	let total = 840000;
	const today = new Date();
	for (let i = days - 1; i >= 0; i--) {
		const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
		total += Math.round(4000 + 6000 * Math.abs(Math.sin(i / 3)) + (i % 7 === 0 ? 9000 : 0));
		out.push({ date: d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'), spins: total });
	}
	return out;
}

function createFakeSite({ siteDir, certDir }) {
	const state = {
		// The daily reward: day 4 of a streak, today not claimed yet.
		daily: { streak: 3, claimed: false },
		sessions: new Set(),
		codes: new Map(),
		requests: [],
		down: false,
		settings: { publicaccount: 1, starsign: 1, allownf: 1, analytics: 1, theme: 0, promoemails: 0, otheremails: 1, recapemails: 1, newsignins: 1 },
		bio: 'Spinning since 2021 🌀',
		outgoing: new Set(),
		friends: new Set(FRIENDS.map((f) => f[0])),
		incoming: new Set(['ab12cd34-4444-4444-8444-444444444444']),
		saves: [],
		// Direct messages, by the other player's id: SpinQueen has written,
		// and it hasn't been read. What the app sends lands here too.
		messages: new Map([[FRIENDS[0][0], [
			{ id: 1, from_me: true, text: 'gg on that last prestige!', sent: Math.floor(Date.now() / 1000) - 7200, read: true },
			{ id: 2, from_me: false, text: 'thanks!! want to race to 25?', sent: Math.floor(Date.now() / 1000) - 600, read: false }
		]]]),
		messageId: 2,
		blocked: new Set(),
		reports: [],
		// The app's screens as the site has them (html/Content/Desktop/), with
		// these files changed: rel => contents. A deploy since the app shipped.
		resourceOverrides: new Map(),
		// How long the list of them takes to come back (ms).
		resourcesDelay: 0,
		// Statuspage's indicator for the server status light.
		statusIndicator: 'minor'
	};

	// /v2/app/resources.php, as html/v2/app/_resources.php lists the folder.
	function desktopFiles(shell) {
		const dir = path.join(siteDir, 'Content', 'Desktop', 'v' + shell);
		const files = new Map();
		const walk = (from, prefix) => {
			let entries = [];
			try { entries = fs.readdirSync(from, { withFileTypes: true }); } catch (err) { return; }
			for (const entry of entries) {
				const rel = prefix ? prefix + '/' + entry.name : entry.name;
				if (entry.isDirectory()) walk(path.join(from, entry.name), rel);
				else if (entry.isFile() && resourcesLib.isSafePath(rel)) files.set(rel, fs.readFileSync(path.join(from, entry.name)));
			}
		};
		walk(dir, '');
		if (shell === SHELL_API) for (const [rel, body] of state.resourceOverrides) files.set(rel, Buffer.from(body));
		let app = '';
		try { app = JSON.parse(fs.readFileSync(path.join(dir, '_release.json'), 'utf8')).app || ''; } catch (err) { /* none */ }
		return { files, app };
	}

	const csrf = 'csrf-' + crypto.randomBytes(6).toString('hex');

	const pfp = (name) => '/pfp/lg/' + name + '.png';
	const friendRow = ([id, username, s, label], relation = 'friends') => ({
		username, id, uuid: id, pfp: pfp(username), default_pfp: false, relation, state: s, label, is_you: false
	});

	function dashboard() {
		const h = history(120);
		const lifetime = h[h.length - 1].spins;
		return {
			ok: true, api: 1,
			account: { username: 'Empanadero', uuid: ME, pfp: pfp('me'), has_custom_pfp: true, email_verified: true, days: 1342 },
			peppers: 1287, pumpkins: 14, pumpkin_season: true,
			spin: { lifetime, prestige: 23, ascends: 4, spins: 61234, progress: 22.61 },
			flappy: { high: 87, recent: 64, played: 412, progress: 73.56 },
			tower: { high: 142, recent: 97, played: 203, progress: 68.3 },
			xp: { total: 48250, rank: 'Golden Folder', icon: '🥟', next: 60000, next_rank: 'Empanada Legend', progress: 61.2, breakdown: [{ label: 'Lifetime Spins', xp: 30120, percent: 62 }, { label: 'Flappy Highscore', xp: 8700, percent: 18 }, { label: 'Tower Highscore', xp: 6430, percent: 13 }, { label: 'Account Longevity', xp: 3000, percent: 7 }] },
			friends: {
				total: state.friends.size, online: 1, pending: state.incoming.size,
				list: FRIENDS.filter((f) => state.friends.has(f[0])).map((f) => ({ username: f[1], uuid: f[0], pfp: pfp(f[1]), default_pfp: false, state: f[2], label: f[3] }))
			},
			spin_history: h,
			daily: daily(),
			generated: Math.floor(Date.now() / 1000)
		};
	}

	// dailyStatus() in the site's v2/_daily.php, for the fake's streak.
	function daily() {
		const { streak, claimed } = state.daily;
		const day = claimed ? Math.max(1, streak) : streak + 1;
		const pays = (n) => (n >= 7 ? 50 : 10);
		const first = Math.max(1, day - 6);
		const week = Array.from({ length: 7 }, (_, i) => {
			const n = first + i;
			return { day: n, reward: pays(n), done: n < day || (n === day && claimed), today: n === day };
		});
		return { claimed, streak, day, reward: pays(day), tomorrow: pays(day + 1), best: Math.max(9, streak), total: 40, week,
			base_reward: 10, streak_reward: 50, streak_days: 7, next_in: claimed ? 5 * 3600 + 12 * 60 : null };
	}

	function board(game) {
		const names = ['SpinQueen', 'Empanadero', 'FlappyFan', 'MasaMaster', 'TowerTom', 'CrispyCrust', 'Jeff', 'Chorizo', 'Golden1', 'PepperPal'];
		return names.map((username, i) => {
			const id = username === 'Empanadero' ? ME : 'ab12cd34-' + String(i).padStart(4, '0') + '-4000-8000-000000000000';
			const row = { rank: i + 1, id, username, pfp: pfp(username), default_pfp: false, private: i === 7 };
			if (!row.private) {
				row.score = game === 'spin' ? 2900000 - i * 210000 : game === 'flappy' ? 140 - i * 9 : 260 - i * 15;
				if (game === 'spin') Object.assign(row, { ascends: 9 - Math.floor(i / 2), prestige: 40 - i * 2 });
				else row.recent = Math.max(1, row.score - 20);
			}
			return row;
		});
	}

	function profile(id) {
		const self = !id || id === ME;
		if (self) {
			return {
				ok: true, api: 1,
				profile: { id: ME, username: 'Empanadero', pfp: pfp('me'), default_pfp: false, is_self: true, admin: false, supporter: true, private: false, email_verified: true, member_since: '2022-07-14', days: 1342, presence: { state: 'online', label: 'Online' }, bio: state.bio, star_sign: { name: 'Cancer', symbol: '♋', blurb: 'Loyal, protective, and very into comfort food.' } },
				relationship: { state: 'self', accepts_requests: true },
				xp: { total: 48250, rank: 'Golden Folder', icon: '🥟', range: [40000, 60000], next: 60000, next_rank: 'Empanada Legend', progress: 61.2, breakdown: [{ label: 'Spin Game', xp: 30120, percent: 62 }, { label: 'Flappy', xp: 8700, percent: 18 }, { label: 'Tower', xp: 6430, percent: 13 }, { label: 'Account age', xp: 3000, percent: 7 }] },
				stats: { spin: { lifetime: 1500000, current: 61234, ascends: 4, prestige: 23 }, flappy: { high: 87, played: 412, recent: 64 }, tower: { high: 142, played: 203, recent: 97, best_streak: 31, perfects: 88 }, peppers: { current: 1287, lifetime: 9120 }, pumpkins: 14, pumpkin_season: true },
				friends: {
					total: state.friends.size, pending: state.incoming.size,
					list: [
						...[...state.incoming].map((fid) => ({ username: 'NewChallenger', id: fid, pfp: pfp('new'), default_pfp: false, relation: 'incoming', state: 'online', label: 'Online', is_you: false })),
						...FRIENDS.filter((f) => state.friends.has(f[0])).map((f) => friendRow(f)),
						...[...state.outgoing].map((fid) => ({ username: 'MasaMaster', id: fid, pfp: pfp('masa'), default_pfp: false, relation: 'outgoing', state: 'offline', label: '', is_you: false }))
					]
				},
				csrf
			};
		}
		const f = FRIENDS.find((x) => x[0] === id) || [id, 'MasaMaster', 'offline', 'Active 1w ago'];
		const relation = state.friends.has(id) ? 'friends' : state.outgoing.has(id) ? 'outgoing' : state.incoming.has(id) ? 'incoming' : 'none';
		return {
			ok: true, api: 1,
			profile: { id, username: f[1], pfp: pfp(f[1]), default_pfp: false, is_self: false, admin: f[1] === 'SpinQueen', supporter: false, private: false, email_verified: null, member_since: '2023-02-02', days: 1001, presence: relation === 'friends' ? { state: f[2], label: f[3] } : null, bio: 'gg', star_sign: null },
			relationship: { state: relation, accepts_requests: true },
			xp: { total: 21000, rank: 'Crimper', icon: '🌀', next: 25000, next_rank: 'Golden Folder', progress: 40, breakdown: [] },
			stats: { spin: { lifetime: 900000, current: 1200, ascends: 1, prestige: 9 }, flappy: { high: 50, played: 99, recent: 21 }, tower: null, peppers: { current: 20, lifetime: 900 }, pumpkins: 0, pumpkin_season: true },
			friends: { total: 2, pending: 0, list: [friendRow(FRIENDS[0])] },
			csrf
		};
	}

	// /v2/app/messages.php, as the site's _messages.php shapes it.
	const person = (id) => {
		const f = FRIENDS.find((x) => x[0] === id) || [id, 'MasaMaster', 'offline', ''];
		const friends = state.friends.has(id);
		return { id, username: f[1], pfp: pfp(f[1]), default_pfp: false, relation: friends ? 'friends' : 'none', state: friends ? f[2] : null, label: friends ? f[3] : null };
	};
	const canMessage = (id) => (state.blocked.has(id) ? 'blocked' : state.friends.has(id) ? null : 'not_friends');
	const dashed = (raw) => String(raw || '').toLowerCase().replace(/-/g, '').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');

	function messages(req, url, form) {
		if (req.method !== 'POST') {
			const id = url.searchParams.get('with');
			if (!id) {
				const conversations = [...state.messages].map(([other, list]) => {
					const last = list[list.length - 1];
					return { with: person(other), last: { id: last.id, from_me: last.from_me, preview: last.text, sent: last.sent, read: last.read },
						unread: list.filter((m) => !m.from_me && !m.read).length, can_message: !canMessage(other), reason: canMessage(other) };
				}).sort((a, b) => b.last.id - a.last.id);
				return { ok: true, api: 1, conversations, unread: conversations.reduce((n, c) => n + c.unread, 0),
					blocked: [...state.blocked].map((b) => person(b)), max_length: 1000, csrf };
			}
			const other = dashed(id);
			const list = state.messages.get(other) || [];
			const after = Number(url.searchParams.get('after')) || 0;
			return { ok: true, api: 1, with: person(other), can_message: !canMessage(other), reason: canMessage(other), blocked: state.blocked.has(other),
				messages: list.filter((m) => m.id > after), has_more: false,
				seen_up_to: list.filter((m) => m.from_me && m.read).reduce((n, m) => Math.max(n, m.id), 0), max_length: 1000, csrf };
		}
		if (form.get('csrf') !== csrf) return { status: 403, body: { ok: false, api: 1, reason: 'csrf' } };
		const action = form.get('action');
		const other = dashed(form.get('to') || form.get('with'));
		if (action === 'send') {
			if (canMessage(other)) return { status: 403, body: { ok: false, api: 1, reason: canMessage(other) } };
			const list = state.messages.get(other) || [];
			const again = list.find((m) => m.nonce && m.nonce === form.get('nonce'));
			if (again) return { ok: true, api: 1, message: again, duplicate: true };
			const message = { id: ++state.messageId, from_me: true, text: form.get('text'), sent: Math.floor(Date.now() / 1000), read: false, nonce: form.get('nonce') };
			list.push(message);
			state.messages.set(other, list);
			return { ok: true, api: 1, message, duplicate: false };
		}
		if (action === 'read') {
			for (const m of state.messages.get(other) || []) if (!m.from_me) m.read = true;
			const unread = [...state.messages.values()].flat().filter((m) => !m.from_me && !m.read).length;
			return { ok: true, api: 1, marked: 1, unread };
		}
		if (action === 'block' || action === 'unblock') {
			if (action === 'block') { state.blocked.add(other); state.friends.delete(other); } else state.blocked.delete(other);
			return { ok: true, api: 1, blocked: action === 'block', unread: 0 };
		}
		if (action === 'report') {
			state.reports.push({ message: Number(form.get('message')), reason: form.get('reason'), note: form.get('note') });
			return { ok: true, api: 1, reported: true };
		}
		return { status: 400, body: { ok: false, api: 1, reason: 'unknown_action' } };
	}

	// A reply from a friend, as the e2e run asks for one.
	state.reply = (id, text) => {
		const list = state.messages.get(id) || [];
		list.push({ id: ++state.messageId, from_me: false, text, sent: Math.floor(Date.now() / 1000), read: false });
		state.messages.set(id, list);
		for (const m of list) if (m.from_me) m.read = true;
	};

	function signedIn(req) {
		const cookie = req.headers.cookie || '';
		const m = /(?:^|;\s*)UAK=([^;]+)/.exec(cookie);
		return !!(m && state.sessions.has(m[1]));
	}

	const send = (res, status, body, headers = {}) => {
		res.writeHead(status, Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store' }, headers));
		res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
	};

	const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.json': 'application/json' };

	function serveStatic(req, res, pathname) {
		let rel = pathname;
		if (['/spin', '/flappy', '/tower'].includes(rel)) rel += '.html';
		// Profile pictures: a few of the site's own pictures, by name.
		if (rel.startsWith('/pfp/')) {
			const pics = ['/Content/Images/Jeff/jeff.png', '/Content/Images/empanada.png', '/Content/Images/floppa.png', '/Content/Images/pumpkin.png', '/Content/Images/Jeff/jeffhd.png'];
			const n = [...rel].reduce((sum, c) => sum + c.charCodeAt(0), 0);
			rel = pics[n % pics.length];
		}
		const file = path.normalize(path.join(siteDir, rel));
		if (!file.startsWith(siteDir + path.sep)) return send(res, 404, 'no', { 'content-type': 'text/plain' });
		fs.stat(file, (err, stat) => {
			if (err || !stat.isFile()) return send(res, 404, '<h1>404</h1>', { 'content-type': 'text/html' });
			const etag = '"' + stat.size.toString(16) + '-' + Math.floor(stat.mtimeMs).toString(16) + '"';
			if (req.headers['if-none-match'] === etag) {
				res.writeHead(304, { etag });
				return res.end();
			}
			const headers = { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', etag, 'content-length': stat.size, 'cache-control': 'public, max-age=3600' };
			if (rel.endsWith('.html')) headers['content-security-policy'] = "frame-ancestors 'self'";
			res.writeHead(200, headers);
			if (req.method === 'HEAD') return res.end();
			fs.createReadStream(file).pipe(res);
		});
	}

	function handle(req, res, body) {
		const url = new URL(req.url, 'https://' + (req.headers.host || 'empanadas.io'));
		const host = (req.headers.host || '').split(':')[0];
		if (!req.delayed) state.requests.push({ host, method: req.method, path: url.pathname, query: url.search, cookie: req.headers.cookie || '', ua: req.headers['user-agent'] || '', at: Date.now() });
		const form = new URLSearchParams(body);
		// /v2/ios/ is an alias of the native API's /v2/app/, as on the site.
		const p = url.pathname.replace(/^\/v2\/ios\//, '/v2/app/');

		// Statuspage: the API the server status light reads, and the hosted
		// status page the app shows in a sheet, with the parts it hides.
		if (host === '9c0yt9mrrj7l.statuspage.io') {
			if (p === '/api/v2/status.json') return send(res, 200, { page: { id: '9c0yt9mrrj7l' }, status: { indicator: state.statusIndicator, description: 'Minor Service Outage' } });
			return send(res, 404, { error: 'not found' });
		}
		if (host === 'empanadas.statuspage.io') {
			const page = (title, main) => '<!doctype html><html><head><meta charset="utf-8"><title>' + title + '</title>' +
				'<style>body{margin:0;background:#1e1e91;color:#fff;font-family:Georgia,serif}.masthead{padding:28px}.container{padding:0 28px}' +
				'.box{background:#fff;color:#222;border-radius:6px;padding:16px;margin-bottom:16px}.updates-dropdown-container{float:right}' +
				'a{color:#9cf}</style></head><body><div class="masthead"><a class="logo-container" href="https://empanadas.io/"><b>Empanadas.io</b></a>' +
				'<div class="updates-dropdown-container"><button class="show-updates-dropdown">Subscribe to Updates</button></div></div>' +
				'<div class="container">' + main + '<div class="powered-by"><a href="https://www.atlassian.com/software/statuspage">Powered by Atlassian Statuspage</a></div></div></body></html>';
			if (p === '/') {
				return send(res, 200, page('Empanadas.io Status', '<div class="box"><b>Partial System Outage</b></div>' +
					'<div class="box">Website — Degraded Performance</div><div class="box">Games — Operational</div>' +
					'<a class="incident" href="/incidents/abc123">Slow leaderboards</a> · <a class="history" href="/history">Incident History</a> · ' +
					'<a class="away" href="https://example.com/elsewhere">Elsewhere</a>'), { 'content-type': 'text/html; charset=utf-8' });
			}
			if (p === '/incidents/abc123') {
				return send(res, 200, page('Slow leaderboards', '<div class="box"><b>Slow leaderboards</b><p>Investigating.</p></div>'), { 'content-type': 'text/html; charset=utf-8' });
			}
			return send(res, 404, 'not found', { 'content-type': 'text/plain' });
		}

		if (host === 'api.empanadas.io') {
			if (p === '/v1/updates.php') {
				const posts = [
					{ id: 'nw2026', title: 'The desktop app goes native', content: '<p>The <b>Empanadas.io</b> app for Mac and Windows is now <i>native</i>: faster screens, games that work offline, and sign-in with your browser.</p><ul><li>Games start from this computer</li><li>Friends and leaderboards in the app</li></ul><script>alert(1)</script><p><a href="https://empanadas.io/updates">Read more</a></p>', date: '2026-11-20 18:00:00', author: { username: 'zach', pfp: '/pfp/lg/zach.png', is_admin: true } },
					{ id: 'pk2026', title: 'Pumpkin season is here 🎃', content: '<p>Find pumpkins in Spin through October.</p>', date: '2026-09-01 12:00:00', author: { username: 'zach', pfp: '/pfp/lg/zach.png', is_admin: true } }
				];
				const page = Number(url.searchParams.get('page')) || 0;
				const post = posts[page];
				return send(res, 200, post ? Object.assign({ found: true, page, total: posts.length }, post) : { found: false, page, total: posts.length }, { 'access-control-allow-origin': 'https://empanadas.io' });
			}
			return send(res, 404, { ok: false });
		}

		if (p === '/v2/ping.php') return send(res, 200, 'Pong!', { 'content-type': 'text/plain' });

		if (p === '/v2/app/resources.php' && state.resourcesDelay && !req.delayed) {
			req.delayed = true;
			setTimeout(() => handle(req, res, body), state.resourcesDelay);
			return undefined;
		}
		if (p === '/v2/app/resources.php') {
			const shell = Number(url.searchParams.get('shell'));
			const { files, app } = desktopFiles(shell);
			const listed = {};
			for (const [rel, body] of [...files].sort()) listed[rel] = { sha256: crypto.createHash('sha256').update(body).digest('hex'), size: body.length };
			return send(res, 200, { ok: true, api: 1, shell, app, revision: resourcesLib.revisionOf(listed), files: listed });
		}
		const desktop = /^\/Content\/Desktop\/v(\d+)\/(.+)$/.exec(p);
		if (desktop && Number(desktop[1]) === SHELL_API && state.resourceOverrides.has(desktop[2])) {
			return send(res, 200, state.resourceOverrides.get(desktop[2]), { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' });
		}

		if (p === '/v2/app/signin.php') {
			const entry = state.codes.get(form.get('code'));
			const verifier = form.get('verifier') || '';
			if (!entry || entry.used || b64url(crypto.createHash('sha256').update(verifier).digest()) !== entry.challenge) {
				return send(res, 400, { ok: false, api: 1, reason: 'expired' });
			}
			entry.used = true;
			const token = 'sess' + crypto.randomBytes(8).toString('hex');
			state.sessions.add(token);
			return send(res, 200, { ok: true, api: 1, account: { username: 'Empanadero' } }, {
				'set-cookie': 'UAK=' + token + '; Path=/; Secure; HttpOnly; SameSite=Lax'
			});
		}

		if (p === '/v2/auth/logout.php') {
			state.sessions.clear();
			res.writeHead(302, { location: '/', 'set-cookie': 'UAK=deleted; Path=/; Max-Age=0; Secure; HttpOnly' });
			return res.end();
		}
		if (p === '/v2/auth/js.php') {
			return send(res, 200, '<!doctype html><script>localStorage.setItem("AFSC", JSON.stringify({theme:0,user:"Empanadero"}));location.replace("/v2/dashboard")</script>', { 'content-type': 'text/html' });
		}

		if (p.startsWith('/v2/')) {
			const inSession = signedIn(req);
			if (p === '/v2/getdata.php') {
				if (url.searchParams.get('type') === 'session') return send(res, 200, inSession ? '1' : 'no_session', { 'content-type': 'text/plain' });
				if (!inSession) return send(res, 200, 'no_session', { 'content-type': 'text/plain' });
				return send(res, 200, { result: true });
			}
			if (p === '/v2/updatedata.php') {
				if (!inSession) return send(res, 200, 'no_session', { 'content-type': 'text/plain' });
				state.saves.push(Object.fromEntries(form));
				return send(res, 200, { result: true });
			}
			if (!inSession) {
				if (p.startsWith('/v2/app/')) return send(res, 401, { ok: false, api: 1, reason: 'no_session' });
				if (p === '/v2/gamehistory.php') return send(res, 200, { result: false, reason: 'no_session' });
				if (p === '/v2/account_edit.php') return send(res, 200, { result: 0, reason: 'no_session' });
				res.writeHead(302, { location: '/v2/login' });
				return res.end();
			}
			switch (p) {
			case '/v2/app/dashboard.php': return send(res, 200, dashboard());
			case '/v2/app/leaderboard.php': return send(res, 200, { ok: true, api: 1, spin: board('spin'), flappy: board('flappy'), tower: board('tower'), you: ME, generated: Math.floor(Date.now() / 1000) - 12, age: 12, ttl: 45 });
			case '/v2/app/profile.php': return send(res, 200, profile((url.searchParams.get('id') || '').toLowerCase()));
			case '/v2/app/account.php': return send(res, 200, {
				ok: true, api: 1,
				account: { id: 7, username: 'Empanadero', email: 'empanadero@example.com', email_verified: true, pending_email: null, pfp: pfp('me'), pfp_small: pfp('me'), has_custom_pfp: true, created_at: '2022-07-14', birthday: '2000-07-01', star_sign: 'Cancer', connections: ['google', 'discord'], two_factor: true, passkeys: 2 },
				has_birthday: true, settings: state.settings, csrf
			});
			case '/v2/app/search.php': {
				const q = (url.searchParams.get('q') || '').toLowerCase();
				const all = [['SpinQueen', FRIENDS[0][0], 'friends'], ['Spinster', 'ab12cd34-5555-4555-8555-555555555555', 'none'], ['SpinDoctor', 'ab12cd34-6666-4666-8666-666666666666', 'none']];
				return send(res, 200, { ok: true, api: 1, query: q, page: 0, has_more: false, results: all.filter((r) => r[0].toLowerCase().includes(q)).map(([username, id, relation]) => ({ id, username, pfp: pfp(username), default_pfp: false, admin: false, supporter: username === 'Spinster', vip: false, private: false, relation: state.outgoing.has(id) ? 'outgoing' : relation, accepts_requests: true })) });
			}
			case '/v2/app/feedback.php': return send(res, 200, { ok: true, api: 1, subjects: [{ id: 1, key: 'general', label: 'General Feedback', input: 'message', placeholder: "What's on your mind?", reply: true, message_required: true }, { id: 5, key: 'bug_report', label: 'Bug Report', input: 'message', placeholder: 'What went wrong?', reply: true, message_required: true }], default_subject: 1, min_length: 6, max_length: 2000, email: 'empanadero@example.com', email_verified: true, csrf });
			case '/v2/account_edit.php': {
				if (form.get('csrf') !== csrf) return send(res, 200, { result: 0, reason: 'csrf' });
				const action = form.get('account_change');
				if (action === 'settings') {
					for (const [k, v] of form) if (k in state.settings) state.settings[k] = Number(v);
				} else if (action === 'bio') {
					state.bio = form.get('m');
				} else if (action === 'add_friend') {
					const uuid = form.get('uuid');
					state.outgoing.add(uuid.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5'));
				} else if (action === 'pending_friend') {
					const id = [...state.incoming][0];
					state.incoming.delete(id);
					if (form.get('r') === '1') state.friends.add(id);
				}
				return send(res, 200, { result: 1 });
			}
			case '/v2/app/messages.php': {
				const answer = messages(req, url, form);
				return answer.status ? send(res, answer.status, answer.body) : send(res, 200, answer);
			}
			case '/v2/app/daily.php': {
				if (req.method !== 'POST') return send(res, 405, { ok: false, api: 1, reason: 'wrong_method' });
				if (form.get('csrf') !== csrf) return send(res, 403, { ok: false, api: 1, reason: 'csrf' });
				if (state.daily.claimed) return send(res, 409, { ok: false, api: 1, reason: 'claimed', daily: daily() });
				state.daily = { streak: state.daily.streak + 1, claimed: true };
				const now = daily();
				return send(res, 200, { ok: true, api: 1, granted: now.reward, peppers: 1287 + now.reward, daily: now });
			}
			case '/v2/gamehistory.php':
				return send(res, 200, { result: true, current: { prestige: 23, ascensions: 4, manual_spins: 1500000, peppers: 1287, flappy_best: 87, tower_best: 142 }, points: [
					{ id: 902, date: '2026-11-19 21:04:00', label: 'Nov 19, 2026 9:04 PM', prestige: 23, ascensions: 4, manual_spins: 1490000, peppers: 1250, flappy_best: 87, tower_best: 140, full: true, restorable: true },
					{ id: 877, date: '2026-11-12 08:30:00', label: 'Nov 12, 2026 8:30 AM', prestige: 22, ascensions: 4, manual_spins: 1380000, peppers: 1100, flappy_best: 80, tower_best: 131, full: true, restorable: true }
				], more: false, before: null });
			default:
				res.writeHead(200, { 'content-type': 'text/html' });
				return res.end('<!doctype html><title>Empanadas.io</title><h1>' + p + '</h1>');
			}
		}
		return serveStatic(req, res, p);
	}

	const server = https.createServer({
		key: fs.readFileSync(path.join(certDir, 'key.pem')),
		cert: fs.readFileSync(path.join(certDir, 'cert.pem'))
	}, (req, res) => {
		if (state.down) {
			req.socket.destroy();
			return;
		}
		const chunks = [];
		req.on('data', (c) => chunks.push(c));
		req.on('end', () => {
			try {
				handle(req, res, Buffer.concat(chunks).toString('utf8'));
			} catch (err) {
				send(res, 500, String(err.stack));
			}
		});
	});

	return {
		state,
		listen: (port, host = '127.0.0.1') => new Promise((resolve) => server.listen(port, host, resolve)),
		close: () => new Promise((resolve) => server.close(resolve)),
		// What the site does when the browser finishes signing in for the
		// app: a one-time code for this challenge (appSigninIssue()).
		mint(challenge) {
			const code = crypto.randomBytes(24).toString('hex');
			state.codes.set(code, { challenge, used: false });
			return code;
		}
	};
}

module.exports = {
	SHELL_API, createFakeSite, ME };
