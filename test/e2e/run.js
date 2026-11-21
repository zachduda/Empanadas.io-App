'use strict';

// Drives the whole app end to end against a fake empanadas.io: sign in
// through the browser hand-off, every screen, a game played from the copy
// kept on disk (online, and again with the site unreachable), and sign out.
// Screenshots of each step go to E2E_OUT (default: test/e2e/out).
//
//   xvfb-run -a -s "-screen 0 1440x960x24" node test/e2e/run.js
//
// Needs a checkout of the site (github.com/zachduda/Empanadas-io) for the
// games' real files: EMPANADAS_SITE_DIR, default ../Empanadas-io/html. And
// Playwright (npm install --no-save playwright), for its Electron driver.

const assert = require('assert');
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFakeSite } = require('./fakesite');

const root = path.join(__dirname, '..', '..');
const siteDir = path.resolve(process.env.EMPANADAS_SITE_DIR || path.join(root, '..', 'Empanadas-io', 'html'));
const out = path.resolve(process.env.E2E_OUT || path.join(__dirname, 'out'));
const port = Number(process.env.E2E_PORT || 8443);

const results = [];
const step = async (name, fn) => {
	const started = Date.now();
	try {
		await fn();
		results.push(['ok', name]);
		console.log('  ok    ' + name + ' (' + (Date.now() - started) + 'ms)');
	} catch (err) {
		results.push(['FAIL', name, err]);
		console.log('  FAIL  ' + name + ' - ' + (err && err.stack || err));
	}
};

function certificate(dir) {
	execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'key.pem'),
		'-out', path.join(dir, 'cert.pem'), '-days', '2', '-subj', '/CN=empanadas.io',
		'-addext', 'subjectAltName=DNS:empanadas.io,DNS:api.empanadas.io'], { stdio: 'ignore' });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(what, fn, timeout = 20000) {
	const end = Date.now() + timeout;
	let last;
	while (Date.now() < end) {
		try {
			last = await fn();
			if (last) return last;
		} catch (err) {
			last = err;
		}
		await wait(200);
	}
	throw new Error('timed out waiting for ' + what + (last instanceof Error ? ': ' + last.message : ''));
}

async function main() {
	const { _electron } = require('playwright');
	if (!fs.existsSync(path.join(siteDir, 'spin.html'))) throw new Error('no site checkout at ' + siteDir + ' (set EMPANADAS_SITE_DIR)');
	fs.mkdirSync(out, { recursive: true });
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'empanadas-e2e-'));
	certificate(tmp);
	const site = createFakeSite({ siteDir, certDir: tmp });
	await site.listen(port);

	const userData = path.join(tmp, 'userData');
	const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
	const electronApp = await _electron.launch({
		executablePath: require(path.join(root, 'node_modules', 'electron')),
		// Electron will not start as root with its sandbox on, which is how
		// it runs in a container. Never in the app itself.
		args: [...(asRoot ? ['--no-sandbox'] : []), path.join(__dirname, 'app'), '--no-update'],
		env: Object.assign({}, process.env, { E2E_PORT: String(port), E2E_USER_DATA: userData, ELECTRON_ENABLE_LOGGING: '1' })
	});

	const consoleErrors = [];
	const win = await electronApp.firstWindow();
	win.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
	win.on('pageerror', (err) => consoleErrors.push(String(err)));

	// The whole window, the game's view included: the X screen, cropped.
	const shot = async (name) => {
		await wait(350);
		const b = await electronApp.evaluate(({ BrowserWindow }) => {
			const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().startsWith('app://shell'));
			return w ? w.getContentBounds() : null;
		});
		const file = path.join(out, name + '.png');
		if (b && process.env.DISPLAY) {
			execFileSync('import', ['-window', 'root', '-crop', b.width + 'x' + b.height + '+' + b.x + '+' + b.y, '+repage', file]);
		} else {
			await win.screenshot({ path: file });
		}
	};

	const requests = (p) => site.state.requests.filter((r) => r.path === p);
	const nav = (label) => win.click('.sidebar .nav-item:has-text("' + label + '")');

	await step('opens on the welcome screen when signed out', async () => {
		await win.waitForSelector('.welcome', { timeout: 20000 });
		await win.waitForSelector('text=Got an account?');
		await shot('01-welcome');
	});

	let opened = null;
	await step('Log In opens the sign-in in the browser with a PKCE challenge', async () => {
		await win.click('text=Yup! Log In');
		opened = await until('the browser to open', async () => (await electronApp.evaluate(() => global.__e2eOpened))[0]);
		const url = new URL(opened);
		assert.strictEqual(url.origin + url.pathname, 'https://empanadas.io/v2/auth/app.php');
		assert.match(url.searchParams.get('challenge'), /^[A-Za-z0-9_-]{43}$/);
		assert.strictEqual(url.searchParams.get('mode'), 'login');
		await win.waitForSelector('text=Finish signing in in your browser');
		await shot('02-waiting-for-browser');
	});

	await step('a sign-in link for someone else\'s challenge signs nobody in', async () => {
		const wrong = site.mint(crypto.randomBytes(32).toString('base64url'));
		await electronApp.evaluate(({ app }, link) => app.emit('second-instance', {}, ['electron', link], '/'), 'empanadas-io://signin?code=' + wrong);
		await win.waitForSelector('.welcome .error', { timeout: 15000 });
		assert.ok(!site.state.sessions.size, 'a session was made');
	});

	await step('the browser\'s empanadas-io://signin link signs the app in', async () => {
		await win.click('text=Yup! Log In');
		const all = await until('the browser to open again', async () => {
			const list = await electronApp.evaluate(() => global.__e2eOpened);
			return list.length >= 2 ? list : null;
		});
		const code = site.mint(new URL(all[all.length - 1]).searchParams.get('challenge'));
		await electronApp.evaluate(({ app }, link) => app.emit('second-instance', {}, ['electron', link], '/'), 'empanadas-io://signin?code=' + code);
		await win.waitForSelector('.greeting', { timeout: 20000 });
		assert.strictEqual(site.state.sessions.size, 1);
		const dash = requests('/v2/ios/dashboard.php').pop();
		assert.match(dash.cookie, /UAK=sess/, 'the dashboard was asked for without the session');
		assert.match(dash.ua, /empanadas\.io\/2\.0\.0/i, 'the app does not name itself in its user agent');
		await win.waitForSelector('.chart');
		await shot('03-home');
	});

	await step('the games are downloaded to this computer', async () => {
		const status = await until('the games to download', async () => {
			const s = await win.evaluate(() => window.native.games.status());
			return s && !s.syncing && s.games.spin.ready && s.games.flappy.ready && s.games.tower.ready ? s : null;
		}, 60000);
		assert.ok(status.files > 30, 'only ' + status.files + ' files');
		console.log('        ' + status.files + ' files, ' + Math.round(status.bytes / 1024) + ' KB' + (status.lastError ? ' (' + status.lastError + ')' : ''));
	});

	await step('Games', async () => {
		await nav('Games');
		await win.waitForSelector('.game-card');
		await win.waitForSelector('text=Offline ready');
		await shot('04-games');
	});

	await step('Leaderboards', async () => {
		await nav('Leaderboards');
		await win.waitForSelector('.list-row.me');
		await win.click('.segmented button:has-text("Flappy")');
		await win.waitForSelector('text=points');
		await shot('05-leaderboards');
	});

	await step('Friends: answer a request, then find someone and add them', async () => {
		await nav('Friends');
		await win.waitForSelector('text=Friend Requests');
		await win.click('.list-row:has-text("NewChallenger") button:has-text("Accept")');
		await win.waitForSelector('text=You\'re now friends!');
		await win.fill('input[type=search]', 'spin');
		await win.waitForSelector('text=Results for');
		await win.click('.list-row:has-text("Spinster") button:has-text("Add Friend")');
		await win.waitForSelector('text=Friend request sent.');
		const edits = requests('/v2/account_edit.php');
		assert.ok(edits.length >= 2, 'no changes reached the site');
		await shot('06-friends');
	});

	await step('My Profile', async () => {
		await nav('My Profile');
		await win.waitForSelector('.profile-head');
		await win.waitForSelector('text=Golden Folder');
		await shot('07-profile');
	});

	await step('Settings, and a setting saved to the account', async () => {
		await win.click('.nav-account');
		await win.waitForSelector('text=Keep Spinning When Closed');
		const before = site.state.settings.promoemails;
		await win.click('.setting:has-text("News and Promotions") .switch');
		await until('the setting to reach the site', () => site.state.settings.promoemails !== before);
		await shot('08-settings');
	});

	await step('Updates, with the post\'s script dropped', async () => {
		await win.click('.titlebar button[title="Updates"]');
		await win.waitForSelector('text=The desktop app goes native');
		const scripts = await win.evaluate(() => document.querySelectorAll('.post-body script').length);
		assert.strictEqual(scripts, 0);
		await shot('09-updates');
	});

	await step('Spin plays from the copy on disk, saving to the account', async () => {
		await nav('Games');
		const pagesBefore = requests('/spin').length + requests('/spin.html').length;
		const savesBefore = site.state.requests.filter((r) => r.path === '/v2/getdata.php' && r.cookie.includes('UAK=sess')).length;
		await win.click('.game-card:has-text("The Spin Game") button:has-text("Play")');
		await until('the game to be open', () => win.evaluate(() => window.native.games.state()).then((s) => s && s.name === 'spin'));
		const game = await until('the game page', () => electronApp.context().pages().find((p) => p.url().startsWith('https://empanadas.io/spin')));
		await game.waitForLoadState('load', { timeout: 20000 });
		await wait(2500);
		const pagesAfter = requests('/spin').length + requests('/spin.html').length;
		assert.strictEqual(pagesAfter, pagesBefore, 'the game page was fetched from the site instead of from disk');
		const fetchedScripts = site.state.requests.filter((r) => r.at > Date.now() - 4000 && /\/Content\/Code\/JS\/(core|spin)\.js/.test(r.path));
		assert.strictEqual(fetchedScripts.length, 0, 'the game\'s scripts came from the site');
		const saves = site.state.requests.filter((r) => r.path === '/v2/getdata.php' && r.cookie.includes('UAK=sess')).length;
		console.log('        save requests with the account\'s session: ' + (saves - savesBefore));
		const title = await game.title();
		console.log('        game title: ' + title);
		await shot('10-playing-spin');
	});

	await step('Home closes the game', async () => {
		await win.click('.titlebar button:has-text("Home")');
		await until('the game to close', () => win.evaluate(() => window.native.games.state()).then((s) => s === null));
		assert.ok(!electronApp.context().pages().some((p) => p.url().startsWith('https://empanadas.io/spin')));
	});

	await step('offline, Flappy still starts from the copy on disk', async () => {
		site.state.down = true;
		await win.click('.game-card:has-text("Flappy Empanada") button:has-text("Play")');
		const game = await until('the game page', () => electronApp.context().pages().find((p) => p.url().startsWith('https://empanadas.io/flappy')));
		await game.waitForLoadState('load', { timeout: 20000 });
		await wait(2500);
		const hasGame = await game.evaluate(() => !!document.querySelector('canvas, #game, body') && document.body.innerText.length > 0);
		assert.ok(hasGame, 'the page is empty');
		await shot('11-flappy-offline');
		await win.click('.titlebar button:has-text("Home")');
		await until('the game to close', () => win.evaluate(() => window.native.games.state()).then((s) => s === null));
		site.state.down = false;
	});

	await step('Sign Out goes back to the welcome screen', async () => {
		await win.click('.nav-account');
		await win.click('.setting:has-text("Sign Out") button');
		await win.click('.modal button:has-text("Sign Out")');
		await win.waitForSelector('.welcome', { timeout: 15000 });
		assert.ok(requests('/v2/auth/logout.php').length >= 1, 'the site was not told');
		const cookies = await electronApp.evaluate(async ({ session }) => {
			const all = [...await session.defaultSession.cookies.get({}), ...await session.fromPartition('persist:play').cookies.get({})];
			return all.filter((c) => c.name === 'UAK').length;
		});
		assert.strictEqual(cookies, 0, 'the session cookie is still kept');
	});

	if (consoleErrors.length) console.log('\n  console errors in the app\'s window:\n    ' + consoleErrors.join('\n    '));
	await electronApp.close();
	await site.close();
	fs.rmSync(tmp, { recursive: true, force: true });

	const failed = results.filter((r) => r[0] === 'FAIL');
	console.log('\n' + (results.length - failed.length) + ' of ' + results.length + ' end-to-end steps passed; screenshots in ' + out);
	if (failed.length || consoleErrors.length) process.exit(1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
