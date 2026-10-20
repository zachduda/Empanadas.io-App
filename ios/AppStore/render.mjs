#!/usr/bin/env node
// Draws the App Store screenshots and creative assets in ios/AppStore/. See
// README.md.
//
//   node ios/AppStore/render.mjs [--site ../Empanadas-io/html] [--compose-only]
//
// Two steps:
//
//  1. Screens, into screens/iphone/ and screens/ipad/ at the devices' full
//     resolution. The games are the site's own pages (--site, a checkout of
//     zachduda/Empanadas-io's html/), played to a good moment with demo
//     numbers. Home, Friends, Games, Leaderboard and the Home Screen widgets
//     are templates/native.html.
//  2. The App Store images: each screen in a device frame under its caption
//     (templates/shot.html), and the creative assets: the product page header,
//     the search results image, the universal asset that can be both, and the
//     in-app event card (templates/creative.html).
//
// --compose-only skips step 1 and uses whatever is in screens/, so a capture
// from the Simulator can take the place of any screen: save it under the
// same name and run again.
//
// Needs Playwright and its Chromium:  npm i --no-save playwright && npx playwright install chromium

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES = path.join(HERE, 'templates');
const args = process.argv.slice(2);
const flag = name => args.includes(name);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const SITE = path.resolve(option('--site', path.join(HERE, '../../../Empanadas-io/html')));

// The screenshots, in App Store order. The first three are the ones search
// results show, so they are the three games. In a title, *a word* is gold and
// | breaks the line. art: the screen floats on the backdrop, with no device
// around it. bleed: on that device, the device is drawn larger and runs off
// the bottom, for a screen whose lower half is empty.
const SHOTS = [
	{ name: '01-spin', screen: 'spin', tag: 'Spin', icon: 'spin', tint: '#2E82EF',
		title: 'Spin the|*empanada*', sub: 'Rack up spins, earn peppers and rank up to Spin Overlord.' },
	{ name: '02-flappy', screen: 'flappy', tag: 'Flappy', icon: 'bird', tint: '#17A673',
		title: 'Flap through|the *gaps*', sub: 'Hold to rise, let go to fall. How far can you fly?' },
	{ name: '03-tower', screen: 'tower', tag: 'Tower', icon: 'stack', tint: '#E0891B',
		title: 'Stack it|*sky-high*', sub: "Drop each empanada just right, and don't let the tower topple." },
	{ name: '04-games', screen: 'games', tag: 'Games', icon: 'gamecontroller', tint: '#D9534F', bleed: 'ipad',
		title: 'Jump right|back *in*', sub: 'Pick up where you left off, with your best scores on every game.' },
	{ name: '05-home', screen: 'home', tag: 'Home', icon: 'house', tint: '#3756E9',
		title: 'Every stat in|*one place*', sub: 'Peppers, high scores and progress for all three games.' },
	{ name: '06-leaderboards', screen: 'leaderboard', tag: 'Leaderboards', icon: 'trophy', tint: '#F5B301',
		title: 'Climb the|*leaderboards*', sub: 'See where you stand in Spin, Flappy and Tower.' },
	{ name: '07-widgets', screen: 'widgets', tag: 'Widgets', icon: 'widget', tint: '#F08000', art: true,
		title: 'Right on your|*Home Screen*', sub: 'Your best scores at a glance. Tap a game to jump straight in.' },
	{ name: '08-friends', screen: 'friends', tag: 'Friends', icon: 'friends', tint: '#7952B3', iphoneOnly: true,
		title: 'Play with|your *friends*', sub: "See who's online and how far your spins have come." },
];

// The creative assets, at Apple's sizes (creative assets specifications in the
// App Store Connect help). Each kind is laid out at size / scale, then
// rendered at scale. The header's size is exact; search results takes 1920x1280
// to 3840x2560, and the event card 1920x1080 to 3840x2160.
const CREATIVE = [
	{ kind: 'header', out: 'product-page-header-3840x1646.png', size: [3840, 1646], scale: 2 },
	{ kind: 'search', out: 'search-results-3840x2560.png', size: [3840, 2560], scale: 2 },
	{ kind: 'universal', out: 'universal-5244x2950.png', size: [5244, 2950], scale: 2 },
	{ kind: 'event', out: 'event-card-3840x2160.png', size: [3840, 2160], scale: 2 },
	{ kind: 'event', out: 'event-card-1920x1080.png', size: [1920, 1080], scale: 1 },
];

// The sizes App Store Connect asks for: iPhone 6.9" and iPad 13". The screen
// is drawn at the device's size in points, then scaled.
const DEVICES = {
	iphone: { out: 'iphone-6.9', size: [1320, 2868], points: [440, 956], scale: 3, native: 'phone',
		insets: { top: 62, bottom: 34, left: 0, right: 0 } },
	ipad: { out: 'ipad-13', size: [2064, 2752], points: [1032, 1376], scale: 2, native: 'pad',
		// The game player hides the status bar, and an iPad has no camera
		// housing, so only the home indicator keeps clear space.
		insets: { top: 0, bottom: 20, left: 0, right: 0 } },
};

const browser = await chromium.launch();
try {
	if (!flag('--compose-only')) {
		if (!fs.existsSync(path.join(SITE, 'spin.html'))) {
			throw new Error(`No site checkout at ${SITE}. Pass --site <Empanadas-io/html>, or --compose-only.`);
		}
		for (const [device, spec] of Object.entries(DEVICES)) {
			const dir = path.join(HERE, 'screens', device);
			fs.mkdirSync(dir, { recursive: true });
			for (const { screen } of shotsFor(device)) {
				console.log(`screen  ${device}/${screen}`);
				const out = path.join(dir, `${screen}.png`);
				if (['spin', 'flappy', 'tower'].includes(screen)) await captureGame(screen, spec, out);
				else await captureNative(screen, spec, out);
			}
		}
	}

	for (const [device, spec] of Object.entries(DEVICES)) {
		const dir = path.join(HERE, spec.out);
		fs.mkdirSync(dir, { recursive: true });
		for (const shot of shotsFor(device)) {
			const out = path.join(dir, `${shot.name}.png`);
			console.log(`compose ${path.relative(HERE, out)}`);
			await render('shot.html', { device, n: SHOTS.indexOf(shot) + 1, img: screenFile(device, shot.screen), ...shot }, spec.size, 1, out);
		}
	}

	fs.mkdirSync(path.join(HERE, 'creative'), { recursive: true });
	const phones = { spin: screenFile('iphone', 'spin'), flappy: screenFile('iphone', 'flappy'), tower: screenFile('iphone', 'tower') };
	for (const { kind, out, size: [width, height], scale } of CREATIVE) {
		const file = path.join(HERE, 'creative', out);
		console.log(`compose ${path.relative(HERE, file)}`);
		await render('creative.html', { kind, ...phones }, [width / scale, height / scale], scale, file);
	}
} finally {
	await browser.close();
}

function shotsFor(device) {
	return SHOTS.filter(shot => !shot.iphoneOnly || device === 'iphone');
}

function screenFile(device, screen) {
	const file = path.join(HERE, 'screens', device, `${screen}.png`);
	if (!fs.existsSync(file)) throw new Error(`Missing ${path.relative(HERE, file)}; run without --compose-only first.`);
	return pathToFileURL(file).href;
}

// A template, at an exact size.
async function render(template, params, [width, height], scale, out) {
	const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
	page.on('pageerror', err => console.error(`  ${template}: ${err.message}`));
	const url = pathToFileURL(path.join(TEMPLATES, template));
	for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
	await page.goto(url.href, { waitUntil: 'networkidle' });
	await page.evaluate(() => window.ready || document.fonts.ready);
	await page.screenshot({ path: out });
	await page.close();
}

// The widgets are drawn on their own, on a clear background, and at 4x: the
// screenshot shows them larger than a screen would.
async function captureNative(screen, spec, out) {
	const art = screen === 'widgets';
	const page = await browser.newPage({ viewport: { width: spec.points[0], height: spec.points[1] }, deviceScaleFactor: art ? 4 : spec.scale });
	const url = pathToFileURL(path.join(TEMPLATES, 'native.html'));
	url.searchParams.set('screen', screen);
	url.searchParams.set('device', spec.native);
	await page.goto(url.href, { waitUntil: 'networkidle' });
	await page.evaluate(() => document.fonts.ready);
	if (art) await page.locator('.widgets').screenshot({ path: out, omitBackground: true });
	else await page.screenshot({ path: out });
	await page.close();
}

// --- The games ---------------------------------------------------------
//
// Each page is loaded as https://empanadas.io/<game>, but from the checkout:
// the readable source (_flappy.js and _tower.js) stands in for the build, with
// a hook into its closure so a script can play it; the stylesheets get the
// device's safe areas, which a desktop browser doesn't have; and nothing is
// sent to the site's API. Files the repository doesn't hold (/Content/Icons)
// come from the live site.

async function openGame(game, spec, hook) {
	const context = await browser.newContext({
		viewport: { width: spec.points[0], height: spec.points[1] }, deviceScaleFactor: spec.scale, isMobile: true, hasTouch: true,
		userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 EmpanadasApp/1.0',
	});
	// What the app's bridge.js sets, so the pages lay out as they do in the
	// app. <html> may not exist yet at document start.
	await context.addInitScript(() => {
		const mark = root => root.setAttribute('data-native-app', 'ios');
		if (document.documentElement) return mark(document.documentElement);
		new MutationObserver((_records, observer) => {
			if (!document.documentElement) return;
			observer.disconnect();
			mark(document.documentElement);
		}).observe(document, { childList: true });
	});
	await context.route(/^https?:\/\/(www\.googletagmanager\.com|[^/]*statuspage\.io|api\.empanadas\.io)\//, route => route.abort());
	await context.route('https://empanadas.io/**', async route => {
		const pathname = decodeURIComponent(new URL(route.request().url()).pathname);
		if (pathname.startsWith('/v2/')) return route.abort();
		if (hook && pathname === `/Content/Code/JS/${game}.js`) {
			const source = fs.readFileSync(path.join(SITE, `Content/Code/JS/_${game}.js`), 'utf8');
			const end = source.lastIndexOf('})();');
			return route.fulfill({ contentType: 'application/javascript', body: source.slice(0, end) + hook + '\n' + source.slice(end) });
		}
		const file = path.join(SITE, pathname === '/' + game ? `${game}.html` : pathname);
		if (pathname.endsWith('.css') && fs.existsSync(file)) {
			const css = fs.readFileSync(file, 'utf8')
				.replace(/env\(safe-area-inset-(top|bottom|left|right)\)/g, (_, side) => spec.insets[side] + 'px');
			return route.fulfill({ contentType: 'text/css', body: css });
		}
		if (fs.existsSync(file) && fs.statSync(file).isFile()) return route.fulfill({ path: file });
		return fromLiveSite(route, pathname);
	});
	const page = await context.newPage();
	page.on('pageerror', err => console.error(`  ${game}: ${err.message}`));
	await page.goto(`https://empanadas.io/${game}`, { waitUntil: 'networkidle', timeout: 60000 });
	await page.evaluate(() => document.fonts.ready);
	return { page, context };
}

async function fromLiveSite(route, pathname) {
	try {
		const response = await route.fetch();
		if (response.ok()) return route.fulfill({ response });
	} catch {
		// Offline, or the site can't be reached from here.
	}
	// Stand-ins for the two things the games need from /Content/Icons.
	if (pathname === '/Content/Icons/pepper.png') return route.fulfill({ path: path.join(SITE, 'Content/FullRes/pepper.png') });
	if (pathname.startsWith('/Content/Icons/fa/')) {
		try {
			const fa = path.dirname(createRequire(import.meta.url).resolve('@fortawesome/fontawesome-free/package.json'));
			return route.fulfill({ path: path.join(fa, pathname.slice('/Content/Icons/fa/'.length)) });
		} catch {
			console.warn(`  ${pathname}: not reachable; npm i --no-save @fortawesome/fontawesome-free to draw the icons offline`);
		}
	}
	return route.fulfill({ status: 404, body: '' });
}

async function captureGame(game, spec, out) {
	const { page, context } = await ({ spin: stageSpin, flappy: stageFlappy, tower: stageTower })[game](spec);
	await page.screenshot({ path: out });
	await context.close();
}

// Spin: a player well into the game. Its numbers come from the account, so
// they are filled in on the page.
async function stageSpin(spec) {
	const game = await openGame('spin', spec);
	await game.page.waitForTimeout(1200);
	await game.page.evaluate(() => {
		document.querySelectorAll('.jt').forEach(el => el.remove()); // Jeff's first-visit tutorial
		const rank = document.querySelector('#rank');
		rank.style.display = '';
		showMedal(RANK_TIERS.find(tier => tier.key === 'olympian2'));
		document.querySelector('#rankname').textContent = 'Spin Olympian II';
		document.querySelector('#rankinfo').textContent = '66% to Level Up';
		rank.style.setProperty('--rank-progress', '66%');
		document.querySelector('#spins').textContent = '83,254 Spins';
		const peppers = document.querySelector('#pepperbox');
		peppers.style.display = '';
		peppers.querySelector('.frontnumber').textContent = '1,113';
		const store = document.querySelector('#storebutton');
		Object.assign(store.style, { display: '', visibility: 'visible', opacity: 1 });
		const account = document.querySelector('#accountdiv');
		account.style.display = '';
		account.querySelector('[name=signed_in_content]').style.display = '';
		account.querySelector('[name=guest_content]').style.display = 'none';
		account.querySelector('[name=username]').textContent = 'mateo';
	});
	await game.page.waitForTimeout(1000);
	return game;
}

// Flappy: a run from 41 points, caught threading a gap: no cloud around the
// empanada, nothing white behind the white score. A simple autopilot flies, and
// posts don't knock it down, so the run lasts until that frame comes; the
// game's frame loop is stopped on it. The sky stays the day's it starts in,
// where at 45 it would turn (every 15 points), its lilac clouds then passing
// the white test behind the score.
async function stageFlappy(spec) {
	const game = await openGame('flappy', spec, `window.__game = {
		get player() { return player; }, get posts() { return posts; }, get fieldH() { return fieldH; }, POST_W,
		set holding(value) { holding = value; },
		start(points) {
			circleHitsRect = () => false;
			circleHitsMountain = () => false;
			setSky = () => {};
			if (state === READY) launch();
			score = points;
			ui.score.textContent = points;
		},
		moment() {
			const next = posts.filter(q => q.x + POST_W > player.x - 20).sort((a, b) => a.x - b.x)[0];
			if (!next || next.halfW) return false;
			const ahead = next.x - player.x;
			return ahead > 30 && ahead < 70
				&& player.y > next.top + 45 && player.y < next.top + next.gap - 45
				&& player.y > fieldH * 0.4 && player.y < fieldH * 0.75
				&& this.scoreClear() && this.playerClear();
		},
		white(x, y, w, h) {
			const pixels = ctx.getImageData(x, y, w, h).data;
			let white = 0;
			for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 200 && pixels[i + 1] > 200 && pixels[i + 2] > 200) white += 1;
			return white / (pixels.length / 4);
		},
		playerClear() {
			const k = fieldK * dpr, r = 60 * k; // the field's units to the canvas's pixels
			return this.white(player.x * k - r, player.y * k - r, 2 * r, 2 * r) < 0.02;
		},
		scoreClear() {
			const digits = document.createRange();
			digits.selectNodeContents(ui.score); // the score's box is the width of the screen; the digits aren't
			const box = digits.getBoundingClientRect(), k = canvas.width / canvas.clientWidth, pad = 12;
			return this.white((box.left - pad) * k, (box.top - pad) * k, (box.width + 2 * pad) * k, (box.height + 2 * pad) * k) < 0.01;
		},
	};`);
	const { page } = game;
	await page.waitForTimeout(1000);
	await page.click('#playbutton');
	await page.waitForTimeout(600);
	await page.evaluate(() => {
		const g = window.__game;
		g.start(41);
		setInterval(() => {
			const next = g.posts.filter(p => p.x + g.POST_W + 30 > g.player.x).sort((a, b) => a.x - b.x)[0];
			const target = next ? next.top + next.gap * 0.55 : g.fieldH * 0.45;
			g.holding = g.player.y + g.player.vy * 18 > target;
		}, 8);
	});
	await page.waitForTimeout(1500);
	const found = await page.evaluate(() => new Promise(resolve => {
		const raf = window.requestAnimationFrame.bind(window);
		let stopped = false;
		window.requestAnimationFrame = frame => raf(time => {
			if (stopped) return;
			frame(time);
			if (window.__game.moment()) {
				stopped = true;
				resolve(true);
			}
		});
		setTimeout(() => {
			stopped = true;
			resolve(false);
		}, 90000);
	}));
	if (!found) console.warn('  flappy: no clear frame in 90s; using the last one');
	return game;
}

// Tower: an autopilot drops each empanada over the top of the stack until
// it stands 14 floors (16 on iPad, where the screen is taller), then waits
// for the next one to swing in.
async function stageTower(spec) {
	const floorsWanted = spec.native === 'pad' ? 16 : 14;
	const game = await openGame('tower', spec, `window.__game = {
		press, top: () => topBlock(), get swing() { return swing; }, get floors() { return floors; },
		get state() { return state; }, get held() { return held; }, get falling() { return falling; },
		get noteHidden() { return ui.hudNote.hidden || getComputedStyle(ui.hudNote).opacity === '0'; },
	};`);
	const { page } = game;
	await page.waitForTimeout(1000);
	await page.click('#playbutton');
	await page.evaluate(() => {
		setInterval(() => {
			const g = window.__game;
			if ((g.state !== 'playing' && g.state !== 'ready') || !g.held || g.falling || window.__stop) return;
			// Where it would land: it keeps half the swing's speed for the fall.
			const lands = g.swing.x + g.swing.vx * 0.5 * Math.sqrt(2 * 180 / 3000);
			if (Math.abs(lands - g.top().shownX) < 3) g.press();
		}, 4);
	});
	for (let i = 0; i < 200; i++) {
		await page.waitForTimeout(500);
		const { floors, state } = await page.evaluate(() => ({ floors: __game.floors, state: __game.state }));
		if (state !== 'playing' && state !== 'ready') throw new Error(`Tower: the stack fell at ${floors} floors; run again`);
		if (floors >= floorsWanted) break;
	}
	await page.evaluate(() => { window.__stop = true; });
	// Once any tip over the tower ("Golden one next!") has gone.
	for (let i = 0; i < 600; i++) {
		const swinging = await page.evaluate(() => {
			const g = __game, off = Math.abs(g.swing.x - g.top().shownX);
			return g.held && !g.falling && off > 12 && off < 25 && g.noteHidden;
		});
		if (swinging) break;
		await page.waitForTimeout(16);
	}
	return game;
}
