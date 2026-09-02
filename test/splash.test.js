'use strict';

// Drives download.html in a real Chromium, because the things most likely to
// break on that page do not show up in a syntax check: a Content-Security-Policy
// that blocks the page's own assets, or a CORS attribute that stops a local
// stylesheet loading. Both fail silently in production - the app still starts,
// it just looks wrong or sits on the splash forever.
//
// Skipped unless `playwright-core` resolves, so `npm ci && npm test` works on a
// machine that has not installed a browser. To run it:
//
//   npm i --no-save playwright-core
//   PLAYWRIGHT_CHROMIUM=/path/to/chrome node test/splash.test.js
//
// Electron ships a Chromium of its own, so this is only about the harness.

const path = require('path');
const fs = require('fs');

const PAGE = 'file://' + path.join(__dirname, '..', 'download.html');

let chromium;
try {
	chromium = require('playwright-core').chromium;
} catch (err) {
	console.log('  skip  browser tests (playwright-core is not installed)');
	module.exports = { failures: [], skipped: true };
	if (require.main === module) process.exit(0);
	return;
}

// Playwright's own download location, then the layout used by the sandboxes
// this repo gets built in, then whatever the caller points at.
function findChrome() {
	if (process.env.PLAYWRIGHT_CHROMIUM) return process.env.PLAYWRIGHT_CHROMIUM;
	const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
	if (root && fs.existsSync(root)) {
		for (const dir of fs.readdirSync(root)) {
			if (!dir.startsWith('chromium-')) continue;
			for (const exe of ['chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
				'chrome-win/chrome.exe']) {
				const candidate = path.join(root, dir, exe);
				if (fs.existsSync(candidate)) return candidate;
			}
		}
	}
	return undefined;
}

const failures = [];

function check(what, condition, detail) {
	if (condition) {
		console.log('  ok    ' + what);
	} else {
		failures.push(what + (detail ? ': ' + detail : ''));
		console.log('  FAIL  ' + what + (detail ? ' - ' + detail : ''));
	}
}

async function main() {
	const executablePath = findChrome();
	const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });

	try {
		// --- the page loads and reaches the dashboard ---------------------
		{
			const ctx = await browser.newContext();
			const page = await ctx.newPage();
			const csp = [];
			const failed = [];
			let dashboard = null;

			page.on('console', (m) => {
				if (/Content Security Policy/i.test(m.text())) csp.push(m.text());
			});
			page.on('requestfailed', (r) =>
				failed.push(r.url() + ' (' + ((r.failure() || {}).errorText || '?') + ')'));

			await ctx.route('https://empanadas.io/v2/ping.php*', (route) =>
				route.fulfill({ status: 200, contentType: 'text/plain', body: 'Pong!' }));
			await ctx.route('https://empanadas.io/v2/dashboard*', (route) => {
				dashboard = route.request().url();
				return route.fulfill({ status: 200, contentType: 'text/html', body: 'ok' });
			});

			await page.goto(PAGE);

			const dom = await page.evaluate(() => ({
				logo: (() => { const i = document.getElementById('logo'); return i.complete && i.naturalWidth > 0; })(),
				background: getComputedStyle(document.body).backgroundColor,
				// animated.css defines this; if the stylesheet did not load the
				// class has no effect and the duration stays at 0s.
				animations: (() => {
					const el = document.createElement('div');
					el.className = 'animated fadeIn';
					document.body.appendChild(el);
					const d = getComputedStyle(el).animationDuration;
					el.remove();
					return d;
				})(),
				jquery: typeof window.$ !== 'undefined',
				appid: localStorage.getItem('AppID')
			}));

			await page.waitForTimeout(6000);

			check('the CSP allows the page its own assets', csp.length === 0, csp.join('; '));
			check('no request fails to load', failed.length === 0, failed.join('; '));
			check('the logo image loads', dom.logo);
			check('the inline stylesheet applies', dom.background === 'rgb(30, 30, 145)', dom.background);
			check('animated.css actually loads',
				dom.animations !== '0s' && dom.animations !== '',
				'animation-duration resolved to "' + dom.animations + '" - the ' +
				'stylesheet did not load (a crossorigin attribute on a file:// ' +
				'<link> will do this)');
			check('jQuery is gone', dom.jquery === false);
			check('an AppID is generated on first run',
				/^[0-9a-f-]{36}$/.test(dom.appid || ''), String(dom.appid));
			check('it navigates to the dashboard', Boolean(dashboard), 'never navigated');
			check('the AppID is passed on the first load, not "undefined"',
				Boolean(dashboard) && dashboard.includes('appid=' + dom.appid),
				String(dashboard));

			await ctx.close();
		}

		// --- the server is unreachable ------------------------------------
		{
			const ctx = await browser.newContext();
			const page = await ctx.newPage();
			let attempts = 0;
			await ctx.route('https://empanadas.io/**', (route) => {
				attempts++;
				return route.abort('connectionrefused');
			});

			await page.goto(PAGE);
			await page.waitForTimeout(1500);

			const msg = await page.textContent('#msg');
			const logo = await page.getAttribute('#logo', 'src');
			check('an unreachable server shows the offline state', msg === 'Check Your Internet', msg);
			check('the offline state swaps in jeff.gif', /jeff\.gif$/.test(logo || ''), String(logo));

			const before = attempts;
			await page.waitForTimeout(6000);
			check('it keeps retrying rather than giving up', attempts > before,
				'no retry after ' + before + ' attempts');
			check('it does not navigate away while offline', page.url().startsWith('file://'));

			await ctx.close();
		}

		// --- the server errors --------------------------------------------
		{
			const ctx = await browser.newContext();
			const page = await ctx.newPage();
			await ctx.route('https://empanadas.io/**', (route) =>
				route.fulfill({ status: 500, contentType: 'text/plain', body: 'nope' }));

			await page.goto(PAGE);
			await page.waitForTimeout(1500);

			// fetch() resolves on a 500 where jQuery's error handler fired, so
			// this is the case the rewrite had to keep working by hand.
			const msg = await page.textContent('#msg');
			check('an HTTP 500 counts as offline, not as success',
				msg === 'Check Your Internet', msg);

			await ctx.close();
		}

		// --- the server answers, but not "Pong!" ---------------------------
		{
			const ctx = await browser.newContext();
			const page = await ctx.newPage();
			let dashboard = null;
			await ctx.route('https://empanadas.io/v2/ping.php*', (route) =>
				route.fulfill({ status: 200, contentType: 'text/plain', body: 'maintenance' }));
			await ctx.route('https://empanadas.io/v2/dashboard*', (route) => {
				dashboard = route.request().url();
				return route.fulfill({ status: 200, body: 'ok' });
			});

			await page.goto(PAGE);
			await page.waitForTimeout(12000);

			check('an unexpected reply falls through to the 10s timer',
				Boolean(dashboard) && dashboard.includes('forceapptimeout=1'), String(dashboard));

			await ctx.close();
		}
	} finally {
		await browser.close();
	}
}

module.exports = { run: main, failures };

if (require.main === module) {
	main().then(() => {
		if (failures.length) {
			console.error('\n' + failures.length + ' failed');
			process.exit(1);
		}
		console.log('\nAll splash tests passed.');
	}).catch((err) => {
		console.error('browser tests could not run: ' + err.message);
		process.exit(1);
	});
}
