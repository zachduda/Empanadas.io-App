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

	// A change to the screens deployed on the site since the app shipped: the
	// app should fetch it behind the loading screen and show it.
	const siteCss = fs.readFileSync(path.join(siteDir, 'Content', 'Desktop', 'v1', 'app.css'), 'utf8');
	site.state.resourceOverrides.set('app.css', siteCss + '\n:root { --e2e-over-the-air: deployed; }\n');
	// Slow enough to see the loading screen at work.
	site.state.resourcesDelay = 2000;

	const userData = path.join(tmp, 'userData');
	const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
	const electronApp = await _electron.launch({
		executablePath: require(path.join(root, 'node_modules', 'electron')),
		// Electron will not start as root with its sandbox on, which is how
		// it runs in a container. Never in the app itself.
		args: [...(asRoot ? ['--no-sandbox'] : []), path.join(__dirname, 'app'), '--no-update'],
		env: Object.assign({}, process.env, { E2E_PORT: String(port), E2E_USER_DATA: userData, ELECTRON_ENABLE_LOGGING: '1', EMPANADAS_RESOURCES: 'on' })
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

	await step('the loading screen shows while the screens are checked against the site', async () => {
		assert.match(win.url(), /^app:\/\/loading\//, 'the window did not open on the loading screen');
		await win.waitForSelector('#logo');
		await win.waitForSelector('#status:has-text("Checking for updates")');
		await wait(900);
		await win.screenshot({ path: path.join(out, '00-loading.png') });
		site.state.resourcesDelay = 0;
		await win.waitForURL(/^app:\/\/shell\//, { timeout: 20000 });
		const listed = requests('/v2/app/resources.php');
		assert.strictEqual(listed.length, 1, 'the site was asked ' + listed.length + ' times for the list');
		assert.strictEqual(listed[0].query, '?shell=1');
		const fetched = site.state.requests.filter((r) => r.path.startsWith('/Content/Desktop/v1/'));
		assert.ok(fetched.length >= 15, 'only ' + fetched.length + ' files fetched');
		assert.ok(fetched.every((r) => /^\?v=[0-9a-f]{64}$/.test(r.query)), 'a file was fetched without its hash');
	});

	await step('the screens are the site\'s copy, with its change', async () => {
		await win.waitForSelector('.welcome', { timeout: 20000 });
		const marker = await win.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--e2e-over-the-air').trim());
		assert.strictEqual(marker, 'deployed', 'the stylesheet deployed on the site is not the one showing');
		const status = await win.evaluate(() => window.native.resources.status());
		assert.ok(status.serving && status.serving === status.kept, 'not serving the kept set: ' + JSON.stringify(status));
		// The loading screen asks nothing of the app but how it is going.
		assert.strictEqual(await win.evaluate(() => typeof window.native.ready), 'function');
	});

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
		const dash = requests('/v2/app/dashboard.php').pop();
		assert.ok(dash, 'the dashboard was not asked for at /v2/app/');
		assert.strictEqual(site.state.requests.filter((r) => r.path.startsWith('/v2/ios/')).length, 0, 'the app used the old /v2/ios/ address');
		assert.match(dash.cookie, /UAK=sess/, 'the dashboard was asked for without the session');
		assert.match(dash.ua, /empanadas\.io\/2\.0\.0/i, 'the app does not name itself in its user agent');
		await win.waitForSelector('.chart');
		await wait(1800); // let Home's entrance animation settle
		await shot('03-home');

		// Experience shows what earned it right there, with no button to
		// open it. The dashboard does not carry it: Home asks for the profile.
		await win.waitForSelector('.home .xp-parts .breakdown .item');
		assert.deepStrictEqual(
			await win.locator('.home .xp-parts .item > span:first-child').allTextContents(),
			['Spin Game', 'Flappy', 'Tower', 'Account age'], 'the breakdown on Home is not the profile\'s');
		assert.strictEqual(await win.locator('.home :text("See What Earned It")').count(), 0, 'the See What Earned It button is back');
		assert.ok(requests('/v2/app/profile.php').length >= 1, 'Home did not ask for the breakdown');
		// The games are symbols on their colours, not the one picture.
		assert.strictEqual(await win.locator('.home .mini-game .game-art svg.game-glyph').count(), 3, 'a game has no symbol');
		assert.strictEqual(await win.locator('.home .game-art img').count(), 0, 'a game still shows a picture');
		await win.evaluate(() => { document.getElementById('content').scrollTop = 1e6; });
		await shot('03-home-experience');
		await win.evaluate(() => { document.getElementById('content').scrollTop = 0; });
		if (process.env.E2E_DARK) { // E2E_DARK=1: Home again in dark mode
			await win.emulateMedia({ colorScheme: 'dark' });
			await nav('Games');
			await nav('Home');
			await wait(1800);
			await shot('03-home-dark');
			await win.emulateMedia({ colorScheme: 'light' });
		}
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
		assert.strictEqual(await win.locator('.game-card .game-art svg.game-glyph').count() >= 3, true, 'the games have no symbols');
		assert.strictEqual(await win.locator('.game-art img').count(), 0, 'a game still shows a picture');
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
		await win.waitForSelector('.setting:has-text("Weekly Recap")');
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
		// Games now offers to jump back in to the game just played.
		await win.waitForSelector('.hero .game-art.spin svg.game-glyph');
		await shot('04-games-jump-back-in');
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

	await step('the account menu under your picture opens My Profile and Settings', async () => {
		await win.click('.titlebar-avatar');
		await win.waitForSelector('.account-menu');
		const labels = await win.$$eval('.account-menu .menu-item', (els) => els.map((e) => e.textContent.trim()));
		assert.deepStrictEqual(labels, ['My Profile', 'Settings', 'App Settings', 'Sign Out']);
		assert.ok(await win.$('.account-menu .menu-divider'), 'no divider above Sign Out');
		await wait(300);
		await shot('12-account-menu');
		await win.click('.account-menu .menu-item:has-text("My Profile")');
		await win.waitForSelector('.account-menu', { state: 'detached' });
		await until('My Profile', () => win.$('.nav-item[aria-current="page"]:has-text("My Profile")'));
		await win.click('.titlebar-avatar');
		await win.keyboard.press('Escape');
		await win.waitForSelector('.account-menu', { state: 'detached' });
		await win.click('.titlebar-avatar');
		await win.click('.account-menu .menu-item:has(span:text-is("Settings"))');
		await win.waitForSelector('.setting:has-text("Sign Out")');
	});

	await step('App Settings, from the account menu: updates, the cache and the versions', async () => {
		await win.click('.titlebar-avatar');
		await win.click('.account-menu .menu-item:has-text("App Settings")');
		await win.waitForSelector('.setting:has-text("Keep Spinning When Closed")');
		await win.waitForSelector('.setting:has-text("Check for Updates")');
		const versions = await win.$$eval('.version-row', (rows) => rows.map((r) => r.textContent));
		const want = await electronApp.evaluate(() => ({ electron: process.versions.electron, chrome: process.versions.chrome }));
		assert.ok(versions.some((t) => t.includes('Electron') && t.includes(want.electron)), 'no Electron version: ' + versions.join(' | '));
		assert.ok(versions.some((t) => t.includes('Chromium') && t.includes(want.chrome)), 'no Chromium version');
		await until('the cache size', () => win.$('.setting:has-text("Cache") .desc:not(:has-text("Working it out"))'));
		await win.click('.setting:has-text("Cache") button:has-text("Clear Cache")');
		await win.waitForSelector('.toast:has-text("Cache cleared")');
		await shot('13-app-settings');
		await win.evaluate(() => document.querySelector('.version-row').scrollIntoView({ block: 'center' }));
		await shot('14-app-settings-versions');
	});

	await step('App Settings: Server Status, and the status page in a sheet', async () => {
		await win.waitForSelector('.setting:has-text("App Components")');
		const row = '.setting.status-row';
		await win.waitForSelector(row + ':has-text("Possible Outage")', { timeout: 15000 });
		assert.ok(await win.$(row + ' .status-dot.yellow.live'), 'no pulsing yellow light');
		await win.evaluate(() => document.querySelector('.status-row').scrollIntoView({ block: 'center' }));
		await shot('15-app-settings-server-status');

		const statusContents = () => electronApp.evaluate(({ webContents }) => {
			const c = webContents.getAllWebContents().find((w) => /statuspage\.io/.test(w.getURL()));
			return c ? c.id : null;
		});
		const inPage = (js) => electronApp.evaluate(({ webContents }, src) => {
			const c = webContents.getAllWebContents().find((w) => /statuspage\.io/.test(w.getURL()));
			// As a click would be: with a user gesture.
			return c ? c.executeJavaScript(src, true) : null;
		}, js);
		const pageView = () => electronApp.evaluate(({ BrowserWindow }) => {
			const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().startsWith('app://shell'));
			const v = w.contentView.children.find((c) => c.webContents && /statuspage\.io/.test(c.webContents.getURL()));
			return v ? { visible: v.getVisible(), bounds: v.getBounds() } : null;
		});

		await win.click(row);
		await win.waitForSelector('.status-sheet:has-text("Server Status")');
		await until('the status page on screen', async () => {
			const v = await pageView();
			return v && v.visible && v.bounds.width > 200 && v.bounds.height > 200;
		});
		const body = await win.$eval('.status-sheet-body', (el) => {
			const r = el.getBoundingClientRect();
			return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
		});
		const view = await pageView();
		assert.ok(Math.abs(view.bounds.x - body.x) <= 1 && Math.abs(view.bounds.y - body.y) <= 1, 'the page is not over the sheet: ' + JSON.stringify([view.bounds, body]));
		assert.strictEqual(await inPage('getComputedStyle(document.querySelector(".updates-dropdown-container")).display'), 'none', 'Subscribe still shows');
		assert.strictEqual(await inPage('getComputedStyle(document.querySelector(".powered-by")).display'), 'none', 'Powered by still shows');
		assert.ok(await win.$('.status-sheet-back[hidden]'), 'Back shows before a link was followed');
		await shot('16-status-page-sheet');

		// A link of the status page's own stays in the sheet, with Back.
		await inPage('document.querySelector("a.incident").click()');
		await win.waitForSelector('.status-sheet-back:not([hidden])');
		await win.click('.status-sheet-back');
		await win.waitForSelector('.status-sheet-back[hidden]', { state: 'attached' });
		// Anywhere else goes to the browser, not the sheet.
		await until('the page back', async () => (await inPage('location.pathname')) === '/');
		await inPage('document.querySelector("a.away").click()');
		await until('the browser opened', async () =>
			(await electronApp.evaluate(() => global.__e2eOpened)).includes('https://example.com/elsewhere'));
		assert.strictEqual(await inPage('location.hostname'), 'empanadas.statuspage.io');

		await win.click('.status-sheet button:has-text("Done")');
		await win.waitForSelector('.status-sheet', { state: 'detached' });
		await until('the page gone', async () => !(await statusContents()));
		assert.ok(!(await pageView()), 'the view is still in the window');
	});

	await step('Sign Out, from the account menu, goes back to the welcome screen', async () => {
		await win.click('.titlebar-avatar');
		await win.click('.account-menu .menu-item.danger:has-text("Sign Out")');
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

	await step('a broken deploy of the screens: the app falls back to its own, and skips that one', async () => {
		site.state.resourceOverrides.set('js/main.js', 'throw new Error("a bad deploy");\n');
		const again = await _electron.launch({
			executablePath: require(path.join(root, 'node_modules', 'electron')),
			args: [...(asRoot ? ['--no-sandbox'] : []), path.join(__dirname, 'app'), '--no-update'],
			env: Object.assign({}, process.env, { E2E_PORT: String(port), E2E_USER_DATA: userData, EMPANADAS_RESOURCES: 'on' })
		});
		try {
			const w = await again.firstWindow();
			await w.waitForURL(/^app:\/\/shell\//, { timeout: 20000 });
			// The broken screens never say they are up; the app's own replace them.
			await w.waitForSelector('.welcome', { timeout: 40000 });
			const status = await w.evaluate(() => window.native.resources.status());
			assert.strictEqual(status.serving, '', 'still serving the broken set');
			const marker = await w.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--e2e-over-the-air').trim());
			assert.strictEqual(marker, '', 'not the app\'s own stylesheet');
			await w.screenshot({ path: path.join(out, '13-fallback-to-bundled.png') });
		} finally {
			await again.close();
		}
	});
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
