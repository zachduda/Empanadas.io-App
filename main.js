'use strict';

// Empanadas.io for the desktop: the main process.
//
// The app is native rather than the website in a window. Its screens - Home,
// Games, Leaderboards, Friends, Profiles, Settings, Updates - are its own
// (shell/, served from app://shell), drawn from the site's JSON API for
// native apps (lib/api.js), and kept for offline (lib/answers.js). Signing in
// happens in the player's own browser (lib/signin.js). The games are still
// the site's own, but kept on this computer (lib/gamebundle.js) and played in
// a view of their own over the window (playGame()), from disk, under the
// site's address (lib/gameprotocol.js).
//
// Two sessions:
//
//  - The default session: the app's screens, the API, and the site's own
//    account pages (a window of their own: openSiteWindow()). It goes to the
//    network the way any browser does.
//  - persist:play: the games. Its https requests are answered by
//    lib/gameprotocol.js. Its empanadas.io cookies are kept the same as the
//    default session's (lib/cookiebridge.js), so the games save to the
//    account that is signed in.

const {
	app, BrowserWindow, WebContentsView, dialog, ipcMain, Menu, nativeImage, nativeTheme, net, Notification,
	powerMonitor, protocol, screen, shell, session, systemPreferences, Tray
} = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const updater = require('./updater');

const {
	isAppUrl, isAuthUrl, isSsoUrl, isPopupUrl, isHandoffUrl,
	isBrowserSignInUrl, isAuthDeepLink, authRedeemUrl, browserUserAgent,
	AUTH_HOSTS
} = require('./lib/urls');
const windowState = require('./lib/windowstate');
const background = require('./lib/background');
const jsonfile = require('./lib/jsonfile');
const signin = require('./lib/signin');
const { createApi, ApiError } = require('./lib/api');
const { createAnswers } = require('./lib/answers');
const gamebundle = require('./lib/gamebundle');
const { createGameHandler } = require('./lib/gameprotocol');
const { createCookieBridge, clearSiteCookies } = require('./lib/cookiebridge');
const { createImageCache } = require('./lib/imagecache');
const { createResources } = require('./lib/resources');
const routes = require('./lib/routes');

const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';

const SITE = 'https://empanadas.io';
const PLAY_PARTITION = 'persist:play';
const SHELL_ORIGIN = 'app://shell';
const SHELL_URL = SHELL_ORIGIN + '/index.html';
const SHELL_ROOT = path.join(__dirname, 'shell');
// The loading screen: always the app's own copy (Content/Loading/), never one
// from the site, since it is what shows while the site's copy is checked.
const LOADING_ORIGIN = 'app://loading';
const LOADING_URL = LOADING_ORIGIN + '/index.html';
const LOADING_ROOT = path.join(__dirname, 'Content', 'Loading');
const SHELL_PRELOAD = path.join(__dirname, 'Content/JS/shell-preload.js');
const GAME_PRELOAD = path.join(__dirname, 'Content/JS/game-preload.js');
const AUTH_PRELOAD = path.join(__dirname, 'Content/JS/auth-preload.js');

// The height of the app's title bar (shell/app.css --titlebar). A game is
// laid out below it, so its Back button and title stay on screen.
const TITLEBAR_HEIGHT = 44;
const GAME_BACKGROUND = '#1e1e91';
const GAME_TITLES = { spin: 'Spin', flappy: 'Flappy', tower: 'Tower' };

// How often a sync of the kept games happens by itself, and how old one may
// be before a game is started without checking for a newer version first.
const BUNDLE_RESYNC = 6 * 60 * 60 * 1000;
const BUNDLE_FRESH_FOR_PLAY = 30 * 60 * 1000;
// Home is kept fresh while the app is open: friend requests, presence.
const DASHBOARD_POLL = 3 * 60 * 1000;

// The screens' own files can come from the site (lib/resources.js). SHELL_API
// is the contract between them and this main process and its preload: bump
// it whenever the screens need something new of either (an IPC channel, a
// field of one), and publish the screens to the site's new folder for it.
const SHELL_API = 1;
// How long the loading screen waits for the site's list of the screens'
// files, and for any that changed, before carrying on with what is on disk
// (the check finishes in the background, for the next launch).
const RESOURCES_WAIT = 6000;
// Long enough for the logo to land; the check is waited for after that.
const LOADING_MIN = 900;
// How long screens from the site get to say they are up (native.ready())
// before the app gives up on them and shows its own.
const SHELL_READY_WAIT = 15000;

// The app's own screens, served from disk. Standard and secure, so they are
// an origin of their own with the modern web platform (modules, fetch).
protocol.registerSchemesAsPrivileged([{
	scheme: 'app',
	privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true }
}]);

app.commandLine.appendSwitch('disable-webgl');
app.commandLine.appendSwitch('disable-webgl2');

// Older builds set NSFullScreenMenuItemEverywhere on every launch, which
// stays in the app's preferences. macOS adds its own Enter Full Screen to the
// View menu once it is gone.
if (isMac) systemPreferences.removeUserDefault('NSFullScreenMenuItemEverywhere');

app.enableSandbox();

const log = (...args) => console.log(...args);

// --- State ------------------------------------------------------------------

let win = null;
// The game being played: { name, view, closing, hidden }.
let game = null;
let gameFullscreen = false;
let quitting = false;
let closingForReal = false;
let handingOff = false;
// Keep Spinning When Closed (lib/background.js): { tray, runner, leaving }.
let bg = null;
let backgroundSettings = null;

let play = null;
let api = null;
let answers = null;
let bundle = null;
let images = null;
let bridge = null;
let pendingSignIn = null;
let accountState = null;
let prefs = null;
let playHistory = null;
let userAgent = '';
let lastPending = null;
let pendingRoute = null;
let pendingPlay = null;
let resources = null;
// The launch's check of the screens' files, once per run.
let startup = null;
let loadingState = { phase: 'starting' };
// Whether the screens in the window have said they are up, and the watchdog
// for screens from the site that do not.
let shellReady = false;
let readyTimer = null;

const authContents = new WeakSet();
const siteContents = new WeakSet();
const siteWindows = new Set();
let openingAuthWindow = false;

// --- One app at a time, and the links it is opened with --------------------

if (process.defaultApp) {
	if (process.argv.length >= 2) {
		app.setAsDefaultProtocolClient('empanadas-io', process.execPath, [path.resolve(process.argv[1])]);
	}
} else {
	app.setAsDefaultProtocolClient('empanadas-io');
}

const gotTheLock = app.requestSingleInstanceLock();

const linkIn = (argv) => (argv || []).find((arg) => typeof arg === 'string' && arg.startsWith('empanadas-io:'));

if (!gotTheLock) {
	app.quit();
} else {
	app.on('second-instance', (_event, commandLine) => {
		const link = linkIn(commandLine);
		if (bg && !link) {
			leaveBackground({ open: true });
			return;
		}
		if (link) handleDeepLink(link);
		else showWindow();
	});
	const first = linkIn(process.argv);
	if (first) app.whenReady().then(() => handleDeepLink(first));
}

app.on('open-url', (event, url) => {
	event.preventDefault();
	if (app.isReady()) handleDeepLink(url);
	else app.whenReady().then(() => handleDeepLink(url));
});

function handleDeepLink(url) {
	if (typeof url !== 'string' || url.length > 2048 || !url.startsWith('empanadas-io:')) return;
	try {
		if (new URL(url).protocol !== 'empanadas-io:') return;
	} catch (err) {
		return;
	}

	if (signin.isSignInLink(url)) {
		finishSignIn(url);
		return;
	}
	if (isAuthDeepLink(url)) {
		finishBrowserConnect(url);
		return;
	}
	const route = routes.deepLinkRoute(url);
	if (!route) return;
	if (bg) {
		pendingRoute = route;
		leaveBackground({ open: true });
		return;
	}
	goTo(route);
}

// --- From the web-wrapper app ------------------------------------------------
// Versions before this one loaded the site in the default session, so the
// games' saves (localStorage) are there. The games now play in persist:play:
// their storage is copied across once, before either session is opened.

function migrateFromWebShell() {
	const userData = app.getPath('userData');
	const marker = path.join(userData, 'native-app.json');
	const done = jsonfile.read(marker);
	if (done && done.migrated) return done;

	const from = path.join(userData, 'Local Storage');
	const to = path.join(userData, 'Partitions', 'play', 'Local Storage');
	try {
		if (fs.existsSync(from) && !fs.existsSync(to)) {
			fs.mkdirSync(path.dirname(to), { recursive: true });
			fs.cpSync(from, to, { recursive: true });
		}
	} catch (err) {
		console.warn('[migrate] could not copy the games\' storage: ' + err.message);
	}
	const old = jsonfile.read(path.join(userData, 'offline.json'));
	const result = { migrated: true, at: Date.now(), hadSignIn: !!(old && old.signedIn), firstRun: true };
	jsonfile.write(marker, Object.assign({}, result, { firstRun: false }));
	return result;
}

// --- Sessions ---------------------------------------------------------------

function lockDownPermissions(ses) {
	const ALLOWED = new Set(['fullscreen', 'pointerLock']);
	ses.setPermissionRequestHandler((contents, permission, callback, details) => {
		const origin = (details && details.requestingUrl) || contents.getURL();
		callback(ALLOWED.has(permission) && isAppUrl(origin));
	});
	ses.setPermissionCheckHandler((_contents, permission, origin) =>
		ALLOWED.has(permission) && isAppUrl(origin));
	ses.setDevicePermissionHandler(() => false);
	if (ses.setBluetoothPairingHandler) ses.setBluetoothPairingHandler(() => {});
}

// Google refuses OAuth from a user agent it recognises as an embedded
// browser. Only matters in the site windows' sign-in popups now (connecting a
// provider on the account page); signing in to the app is in the browser.
function useBrowserUserAgentForAuth(ses) {
	const clean = browserUserAgent(app.userAgentFallback, app.getName());
	const filter = { urls: [...AUTH_HOSTS].map((host) => 'https://' + host + '/*') };
	ses.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
		if (!isAuthUrl(details.url)) {
			callback({ requestHeaders: details.requestHeaders });
			return;
		}
		const headers = Object.assign({}, details.requestHeaders);
		for (const name of Object.keys(headers)) {
			if (name.toLowerCase() === 'user-agent') delete headers[name];
		}
		headers['User-Agent'] = clean;
		callback({ requestHeaders: headers });
	});
}

const CONTENT_TYPES = {
	'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
	'.gif': 'image/gif', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon'
};

const SHELL_CSP = [
	"default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:",
	"font-src 'self'", "connect-src 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"
].join('; ');

// app://shell/...: shell/ (or the site's copy of it, lib/resources.js), its
// fonts and pictures from Content/, and the picture cache at /__img?u=. And
// app://loading/...: the loading screen, only ever the app's own.
function decodePath(pathname) {
	let decoded;
	try {
		decoded = decodeURIComponent(pathname);
	} catch (err) {
		return null;
	}
	if (decoded === '/' || decoded === '') decoded = '/index.html';
	if (decoded.includes('\0') || decoded.includes('\\')) return null;
	return decoded;
}

function bundledFile(decoded, ownRoot) {
	const roots = [
		['/fonts/', path.join(__dirname, 'Content', 'Fonts')],
		['/images/', path.join(__dirname, 'Content', 'Images')],
		['/', ownRoot]
	];
	if (decoded === '/icon.png') return path.join(__dirname, 'icon.png');
	for (const [prefix, root] of roots) {
		if (!decoded.startsWith(prefix)) continue;
		const file = path.normalize(path.join(root, decoded.slice(prefix.length)));
		return file.startsWith(root + path.sep) ? file : null;
	}
	return null;
}

function shellFile(pathname) {
	const decoded = decodePath(pathname);
	if (!decoded) return null;
	const fromSite = resources ? resources.resolve(decoded.slice(1)) : null;
	return fromSite || bundledFile(decoded, SHELL_ROOT);
}

function loadingFile(pathname) {
	const decoded = decodePath(pathname);
	return decoded ? bundledFile(decoded, LOADING_ROOT) : null;
}

async function shellProtocol(request) {
	const url = new URL(request.url);
	if (url.host !== 'shell' && url.host !== 'loading') return new Response('Not found', { status: 404 });

	if (url.host === 'shell' && url.pathname === '/__img') {
		const picture = await images.get(url.searchParams.get('u'));
		if (!picture) return new Response('', { status: 404 });
		return new Response(picture.body, { headers: { 'content-type': picture.type, 'cache-control': 'max-age=600' } });
	}

	const file = url.host === 'shell' ? shellFile(url.pathname) : loadingFile(url.pathname);
	// The type from the address: a file from the site is kept under its hash.
	const decoded = decodePath(url.pathname) || '';
	const type = file && CONTENT_TYPES[path.extname(decoded).toLowerCase()];
	if (!file || !type) return new Response('Not found', { status: 404 });
	try {
		const body = await fs.promises.readFile(file);
		const headers = { 'content-type': type, 'x-content-type-options': 'nosniff', 'cache-control': 'no-cache' };
		if (type.startsWith('text/html')) headers['content-security-policy'] = SHELL_CSP;
		return new Response(body, { headers });
	} catch (err) {
		return new Response('Not found', { status: 404 });
	}
}

function passThrough(request, signal) {
	const init = { bypassCustomProtocolHandlers: true, signal };
	if (request.body) init.duplex = 'half';
	return play.fetch(request, init);
}

// What the site's games read to know they are in the app (dashboard.php sets
// it for the web-wrapper app): their own close buttons then go back to the
// dashboard, which closes the game here, rather than to the homepage.
function setAppCookie() {
	const cookie = {
		url: SITE + '/', name: 'IUNA', value: '1', path: '/', secure: true, httpOnly: false, sameSite: 'lax',
		expirationDate: Math.floor(Date.now() / 1000) + 2 * 365 * 24 * 60 * 60
	};
	return session.defaultSession.cookies.set(cookie).catch(() => {});
}

function setUpSessions() {
	userAgent = app.userAgentFallback;
	const main = session.defaultSession;
	play = session.fromPartition(PLAY_PARTITION);
	for (const ses of [main, play]) {
		ses.setUserAgent(userAgent);
		lockDownPermissions(ses);
	}
	useBrowserUserAgentForAuth(main);
	main.protocol.handle('app', shellProtocol);

	const userData = app.getPath('userData');
	bundle = gamebundle.createBundle({
		dir: path.join(userData, 'Games'),
		fetch: (url, init) => main.fetch(url, init),
		userAgent: () => userAgent,
		log
	});
	play.protocol.handle('https', createGameHandler({
		bundle,
		passThrough,
		online: () => net.isOnline(),
		log
	}));

	bridge = createCookieBridge(main.cookies, play.cookies, { log });
	bridge.start();
	setAppCookie();

	images = createImageCache({
		dir: path.join(userData, 'Pictures'),
		fetch: (url, init) => main.fetch(url, init),
		userAgent: () => userAgent
	});

	answers = createAnswers(path.join(userData, 'Answers'));

	// The screens' files from the site. Off when running from source unless
	// asked for, so shell/ is what a developer sees; EMPANADAS_RESOURCES=off
	// turns it off in the installed app too.
	const resourcesSetting = String(process.env.EMPANADAS_RESOURCES || '').toLowerCase();
	resources = createResources({
		dir: path.join(userData, 'Resources'),
		fetch: (url, init) => main.fetch(url, init),
		api: SHELL_API,
		appVersion: app.getVersion(),
		userAgent: () => userAgent,
		enabled: resourcesSetting === 'off' ? false : (app.isPackaged || resourcesSetting === 'on'),
		log
	});
	api = createApi({
		fetch: (url, init) => main.fetch(url, Object.assign({ bypassCustomProtocolHandlers: true }, init)),
		userAgent: () => userAgent,
		onSignedOut: () => markSignedOut('expired')
	});

	let lastEmit = 0;
	let emitTimer = null;
	bundle.onChange(() => {
		const send = () => {
			emitTimer = null;
			lastEmit = Date.now();
			sendToShell('games', gamesStatus());
		};
		if (emitTimer) return;
		const wait = Math.max(0, 400 - (Date.now() - lastEmit));
		emitTimer = setTimeout(send, wait);
	});
}

// --- The signed-in account ---------------------------------------------------

function isSignedIn() {
	return !!(accountState && accountState.get().signedIn);
}

function sessionInfo() {
	const state = accountState.get();
	const request = pendingSignIn ? pendingSignIn.get() : null;
	return {
		signedIn: !!state.signedIn,
		username: state.signedIn ? String(state.username || '') : '',
		signingIn: !!request,
		mode: request ? request.mode : null
	};
}

function notifySession(extra) {
	sendToShell('session', Object.assign(sessionInfo(), extra || {}));
	buildAppMenu();
	updateQuickPlay();
}

function startSignIn(mode) {
	const request = pendingSignIn.start(mode === 'create' ? 'create' : 'login');
	shell.openExternal(request.url).catch((err) => {
		log('[signin] could not open the browser: ' + err.message);
		sendToShell('signin', { state: 'failed', error: { code: 'browser', message: "Couldn't open your browser. Try again." } });
	});
	notifySession();
	return sessionInfo();
}

function cancelSignIn() {
	pendingSignIn.clear();
	notifySession();
	return sessionInfo();
}

let finishingSignIn = false;

async function finishSignIn(link) {
	const code = signin.signInCode(link);
	const request = pendingSignIn.get();
	showWindow();
	if (!code || !request) {
		log('[signin] ignored a sign-in link the app was not waiting for');
		sendToShell('signin', { state: 'failed', error: { code: 'expired', message: 'That sign-in link has expired. Sign in again from here.' } });
		return;
	}
	if (finishingSignIn) return;
	finishingSignIn = true;
	sendToShell('signin', { state: 'finishing' });
	try {
		// The last account's cookies could otherwise ride along with the new
		// session's until a page replaced them.
		await clearSiteCookies(session.defaultSession.cookies);
		const reply = await api.redeemSignIn(code, request.verifier);
		pendingSignIn.clear();
		answers.clear();
		playHistory.reset();
		accountState.set({ signedIn: true, username: (reply.account && reply.account.username) || '' });
		await setAppCookie();
		await bridge.syncAtoB().catch(() => {});
		runSignedInHandoff();
		scheduleBundleSync(2000);
		notifySession({ justSignedIn: true });
		sendToShell('signin', { state: 'done' });
	} catch (err) {
		const error = errorOf(err);
		if (error.code === 'expired') pendingSignIn.clear();
		sendToShell('signin', { state: 'failed', error });
		notifySession();
	} finally {
		finishingSignIn = false;
		if (isMac) app.focus({ steal: true });
	}
}

// /v2/auth/js.php, which every sign-in on the site passes through, fills in
// what the site's scripts keep in storage about the account (the cache
// core.js reads before it asks the site anything). A sign-in made in the
// browser left that in the browser, so it is loaded once, out of sight, in
// the games' session, and stopped where it would go on to the dashboard.
function runSignedInHandoff() {
	const hidden = new BrowserWindow({
		show: false,
		webPreferences: {
			partition: PLAY_PARTITION,
			preload: AUTH_PRELOAD,
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
			webviewTag: false,
			devTools: false
		}
	});
	const done = () => { if (!hidden.isDestroyed()) hidden.destroy(); };
	const timer = setTimeout(done, 20 * 1000);
	hidden.on('closed', () => clearTimeout(timer));
	const stop = (event, url) => {
		if (!isAppUrl(url) || new URL(url).pathname !== '/v2/auth/js.php') {
			event.preventDefault();
			setImmediate(done);
		}
	};
	hidden.webContents.on('will-navigate', stop);
	hidden.webContents.on('will-redirect', stop);
	hidden.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
	hidden.loadURL(SITE + '/v2/auth/js.php?r=' + encodeURIComponent('/v2/dashboard')).catch(() => done());
}

let signingOut = false;

async function signOut() {
	if (signingOut) return sessionInfo();
	signingOut = true;
	try {
		await closeGame();
		for (const w of [...siteWindows]) if (!w.isDestroyed()) w.close();
		await api.signOut();
		await Promise.all([clearSiteCookies(session.defaultSession.cookies), clearSiteCookies(play.cookies)]);
		await setAppCookie();
		markSignedOut('signed_out');
	} finally {
		signingOut = false;
	}
	return sessionInfo();
}

// The account is gone from the app: signed out here, or the site said the
// session has ended ('expired').
function markSignedOut(why) {
	if (!accountState.get().signedIn) return;
	accountState.set({ signedIn: false, username: '' });
	answers.clear();
	playHistory.reset();
	api.forgetToken();
	lastPending = null;
	setBadge(0);
	notifySession({ why });
}

// --- Screens' data -----------------------------------------------------------

function errorOf(err) {
	if (err instanceof ApiError) return { code: err.code, message: err.message };
	return { code: 'unknown', message: (err && err.message) || 'Something went wrong.' };
}

// Tokens stay in this process.
function forShell(body) {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
	const out = Object.assign({}, body);
	delete out.csrf;
	return out;
}

const LOADERS = {
	account: () => api.account(),
	dashboard: () => api.dashboard(),
	leaderboard: () => api.leaderboard(),
	profile: (params) => api.profile(params && params.id),
	search: (params) => api.search(params && params.q, params && params.page),
	feedbackForm: () => api.feedbackForm(),
	savePoints: (params) => api.savePoints(params && params.before),
	announcement: (params) => api.announcement(params || {})
};

// Which answers are kept for offline, under which key.
function keepAs(key, params) {
	if (key === 'profile') return params && params.id ? null : 'profile';
	if (key === 'announcement') return params && !params.id && !params.page ? 'updates' : null;
	return ['account', 'dashboard', 'leaderboard'].includes(key) ? key : null;
}

function cachedScreen(key, params) {
	const kept = keepAs(key, params);
	const entry = kept ? answers.load(kept) : null;
	return entry ? { ok: true, data: forShell(entry.body), savedAt: entry.savedAt, fresh: false } : null;
}

async function loadScreen(key, params) {
	const loader = LOADERS[key];
	if (!loader) return { ok: false, error: { code: 'invalid', message: 'Unknown screen.' } };
	const generation = answers.generation;
	try {
		const body = await loader(params || {});
		const kept = keepAs(key, params);
		if (kept) answers.save(kept, body, generation);
		if (key === 'dashboard') afterDashboard(body);
		if (key === 'account') afterAccount(body);
		return { ok: true, data: forShell(body), savedAt: Date.now(), fresh: true };
	} catch (err) {
		const cached = cachedScreen(key, params);
		return Object.assign({ ok: false, error: errorOf(err) }, cached ? { data: cached.data, savedAt: cached.savedAt } : {});
	}
}

const ACTIONS = {
	addFriend: (p) => api.addFriend(p.id),
	answerFriend: (p) => api.answerFriend(p.id, p.accept === true),
	removeFriend: (p) => api.removeFriend(p.id),
	updateBio: (p) => api.updateBio(p.text),
	updateSetting: (p) => api.updateSetting(p.field, p.value),
	sendFeedback: (p) => api.sendFeedback(p),
	restoreSavePoint: (p) => api.restoreSavePoint(p.id),
	deleteAccount: (p) => api.deleteAccount(p.confirmation)
};

async function act(action, params) {
	const run = ACTIONS[action];
	if (!run || !params || typeof params !== 'object') return { ok: false, error: { code: 'invalid', message: 'Unknown action.' } };
	try {
		const reply = await run(params);
		if (action === 'updateSetting' && params.field === 'theme') applyTheme(Number(params.value));
		if (action === 'deleteAccount') {
			await Promise.all([clearSiteCookies(session.defaultSession.cookies), clearSiteCookies(play.cookies)]);
			markSignedOut('deleted');
		}
		return { ok: true, data: forShell(reply) };
	} catch (err) {
		return { ok: false, error: errorOf(err) };
	}
}

function afterAccount(body) {
	const settings = body && body.settings;
	if (settings && Number.isInteger(settings.theme)) applyTheme(settings.theme);
	if (body && body.account && body.account.username) accountState.set({ username: body.account.username });
}

function afterDashboard(body) {
	if (!body) return;
	if (body.account && body.account.username && body.account.username !== accountState.get().username) {
		accountState.set({ username: body.account.username });
	}
	const pending = Math.max(0, Number(body.friends && body.friends.pending) || 0);
	setBadge(pending);
	if (lastPending !== null && pending > lastPending && prefs.get().notifications !== false &&
		(!win || win.isDestroyed() || !win.isFocused())) {
		notify(pending - lastPending === 1 ? 'New friend request' : (pending - lastPending) + ' new friend requests',
			'Open Empanadas.io to see who wants to be your friend.', { screen: 'friends' });
	}
	lastPending = pending;
}

function setBadge(count) {
	try {
		if (isMac || process.platform === 'linux') app.setBadgeCount(count);
	} catch (err) {
		// Not every desktop has a badge.
	}
}

function notify(title, body, route) {
	try {
		if (!Notification.isSupported()) return;
		const note = new Notification({ title, body, silent: false });
		note.on('click', () => {
			showWindow();
			if (route) goTo(route);
		});
		note.show();
	} catch (err) {
		// The badge says so too.
	}
}

let dashboardTimer = null;

function startDashboardPoll() {
	if (dashboardTimer) return;
	dashboardTimer = setInterval(async () => {
		if (!isSignedIn() || bg || !win || win.isDestroyed() || !net.isOnline()) return;
		const result = await loadScreen('dashboard');
		sendToShell('data', { key: 'dashboard', result });
	}, DASHBOARD_POLL);
	if (dashboardTimer.unref) dashboardTimer.unref();
}

// --- The kept games ----------------------------------------------------------

function gamesStatus() {
	const status = bundle.status();
	return Object.assign(status, { history: playHistory ? playHistory.get() : {}, online: net.isOnline(), playing: game ? game.name : null });
}

let bundleTimer = null;

function scheduleBundleSync(delay) {
	if (bundleTimer) clearTimeout(bundleTimer);
	bundleTimer = setTimeout(() => {
		bundleTimer = null;
		if (net.isOnline() && !bg) bundle.sync();
	}, delay);
	if (bundleTimer.unref) bundleTimer.unref();
}

function startBundleSchedule() {
	const status = bundle.status();
	if (Date.now() - status.syncedAt > BUNDLE_RESYNC || !status.complete) scheduleBundleSync(3000);
	const timer = setInterval(() => {
		if (Date.now() - bundle.status().syncedAt > BUNDLE_RESYNC) scheduleBundleSync(0);
	}, 30 * 60 * 1000);
	if (timer.unref) timer.unref();
}

function withTimeout(promise, ms) {
	let timer;
	return Promise.race([
		promise,
		new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); })
	]).finally(() => clearTimeout(timer));
}

// --- The game player ---------------------------------------------------------

function layoutGame() {
	if (!game || !win || win.isDestroyed()) return;
	const [width, height] = win.getContentSize();
	const top = gameFullscreen ? 0 : TITLEBAR_HEIGHT;
	game.view.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
}

function gameState() {
	return game ? { name: game.name, title: GAME_TITLES[game.name], hidden: !!game.hidden, fullscreen: gameFullscreen } : null;
}

function sendGameState() {
	sendToShell('game', gameState());
}

async function playGame(name) {
	if (!Object.prototype.hasOwnProperty.call(gamebundle.GAMES, name)) return { ok: false };
	if (!isSignedIn()) return { ok: false, error: { code: 'signed_out', message: 'Sign in to play.' } };
	showWindow();
	if (!win) return { ok: false };
	if (!showingShell() && !shellReady) {
		// Still on the loading screen: it starts once the screens are up.
		pendingPlay = name;
		return { ok: true, pending: true };
	}
	if (game && game.name === name) {
		showGame();
		return { ok: true };
	}
	if (game) await closeGame();

	const online = net.isOnline();
	if (!online && !bundle.gameReady(name)) {
		return { ok: false, error: { code: 'offline', message: GAME_TITLES[name] + " hasn't been downloaded yet. Connect to the internet to play it the first time." } };
	}
	// A game is not started on a copy more than a while old without asking
	// the site whether it changed (almost always a page of "no").
	if (online && Date.now() - bundle.status().syncedAt > BUNDLE_FRESH_FOR_PLAY) {
		sendToShell('game', { name, title: GAME_TITLES[name], loading: true });
		await withTimeout(bundle.sync(), 6000);
	}
	await withTimeout(bridge.syncAtoB().catch(() => {}), 3000);
	if (!win || win.isDestroyed()) return { ok: false };

	const view = new WebContentsView({
		webPreferences: {
			partition: PLAY_PARTITION,
			preload: GAME_PRELOAD,
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
			nodeIntegrationInSubFrames: false,
			webviewTag: false,
			webSecurity: true,
			allowRunningInsecureContent: false,
			experimentalFeatures: false,
			spellcheck: false,
			devTools: !app.isPackaged
		}
	});
	view.setBackgroundColor(GAME_BACKGROUND);
	game = { name, view, closing: false, hidden: false };
	guardGame(view.webContents);
	win.contentView.addChildView(view);
	layoutGame();
	view.webContents.loadURL(SITE + gamebundle.GAMES[name]).catch(() => {});
	view.webContents.focus();

	playHistory.set({ [name]: Date.now() });
	updateQuickPlay();
	sendGameState();
	sendToShell('games', gamesStatus());
	return { ok: true };
}

// Takes the game off screen without closing it: a game's link to one of the
// app's own screens (Spin's Report a Problem, a player's profile) shows that
// screen, with a way back to the game.
function hideGame() {
	if (!game || game.hidden) return;
	game.hidden = true;
	game.view.setVisible(false);
	if (win && !win.isDestroyed()) win.webContents.focus();
	sendGameState();
}

function showGame() {
	if (!game) return;
	game.hidden = false;
	game.view.setVisible(true);
	layoutGame();
	game.view.webContents.focus();
	sendGameState();
}

async function closeGame() {
	if (!game || game.closing) return;
	const g = game;
	g.closing = true;
	const contents = g.view.webContents;
	// Leaving the page lets it save on the way out, as closing a browser tab
	// would (its pagehide and unload handlers run).
	if (!contents.isDestroyed()) {
		await withTimeout(contents.loadURL('about:blank').catch(() => {}), 2500);
	}
	if (win && !win.isDestroyed()) win.contentView.removeChildView(g.view);
	if (!contents.isDestroyed()) contents.close();
	if (game === g) game = null;
	gameFullscreen = false;
	sendGameState();
	sendToShell('games', gamesStatus());
	if (win && !win.isDestroyed()) win.webContents.focus();
	// What the round changed, once the site has the save.
	setTimeout(async () => {
		if (!isSignedIn() || !win || win.isDestroyed()) return;
		sendToShell('data', { key: 'dashboard', result: await loadScreen('dashboard') });
	}, 1500);
}

function guardGame(contents) {
	const guard = (event, url, isMainFrame) => {
		if (!isMainFrame) {
			if (!/^https:\/\//i.test(url)) event.preventDefault();
			return;
		}
		const other = routes.gameOfUrl(url);
		if (other) {
			if (game && game.view.webContents === contents) game.name = other;
			return;
		}
		event.preventDefault();
		if (routes.isGameExitUrl(url)) {
			closeGame();
		} else if (isAppUrl(url)) {
			followSiteLink(url);
		} else if (/^https:\/\//i.test(url)) {
			shell.openExternal(url);
		}
	};
	const mainFrame = (event, positional) =>
		typeof event.isMainFrame === 'boolean' ? event.isMainFrame : positional !== false;
	contents.on('will-navigate', (event, url, _inPlace, isMainFrame) => guard(event, url, mainFrame(event, isMainFrame)));
	contents.on('will-redirect', (event, url, _inPlace, isMainFrame) => guard(event, url, mainFrame(event, isMainFrame)));
	contents.setWindowOpenHandler(({ url }) => {
		if (isAppUrl(url)) followSiteLink(url);
		else if (/^https:\/\//i.test(url)) shell.openExternal(url);
		return { action: 'deny' };
	});
	contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
		if (!isMainFrame || code === -3 || !game || game.view.webContents !== contents) return;
		if (!routes.gameOfUrl(url)) return;
		const title = GAME_TITLES[game.name];
		closeGame().then(() => sendToShell('toast', {
			kind: 'error',
			message: net.isOnline() ? title + " couldn't be loaded (" + description + ').' : title + " isn't downloaded yet. Connect to the internet to play it."
		}));
	});
	contents.on('render-process-gone', (_event, details) => {
		if (!details || details.reason === 'clean-exit') return;
		console.warn('[game] the game went away: ' + details.reason);
		closeGame().then(() => sendToShell('toast', { kind: 'error', message: 'The game stopped unexpectedly. Your progress up to the last save is safe.' }));
	});
	contents.on('unresponsive', async () => {
		if (!win || win.isDestroyed()) return;
		const { response } = await dialog.showMessageBox(win, {
			type: 'warning', title: 'Empanadas.io', message: 'The game is not responding.',
			detail: 'You can wait for it, or close it.', buttons: ['Wait', 'Close Game'], defaultId: 0, cancelId: 0
		});
		if (response === 1 && game && game.view.webContents === contents) {
			contents.forcefullyCrashRenderer();
		}
	});
	contents.on('enter-html-full-screen', () => {
		gameFullscreen = true;
		if (win && !win.isDestroyed() && !win.isFullScreen()) win.setFullScreen(true);
		layoutGame();
		sendGameState();
	});
	contents.on('leave-html-full-screen', () => {
		gameFullscreen = false;
		layoutGame();
		sendGameState();
	});
	contents.on('before-input-event', (event, input) => {
		// Cmd/Ctrl+W closes the game, as it would a tab, rather than the app.
		if (input.type === 'keyDown' && (input.meta || input.control) && !input.alt && !input.shift &&
			String(input.key).toLowerCase() === 'w') {
			event.preventDefault();
			closeGame();
		}
	});
}

// A link to the site from a game or a site page: the app's own screen when it
// has one, the site's account pages in a window of their own, anything else
// of the site's in the browser.
function followSiteLink(url) {
	const route = routes.siteRoute(url);
	if (route) {
		goTo(route);
		return;
	}
	const pathname = new URL(url).pathname;
	if (pathname.startsWith('/v2/')) openSiteWindow(url);
	else shell.openExternal(url);
}

function goTo(route) {
	if (!route) return;
	if (route.play) {
		playGame(route.play);
		return;
	}
	showWindow();
	if (game && !game.hidden) hideGame();
	if (!sendToShell('route', route)) pendingRoute = route;
}

// --- The site's own pages ---------------------------------------------------
// Changing the profile picture, the address or username, connections,
// passkeys and two-factor are the site's pages, signed in as the app is, in a
// window of their own with a native frame. Its rules are the web-wrapper
// app's for its main window: the site and the sign-in providers only, a
// popup only when the site asks for one.

const SITE_PAGES = {
	account: '/v2/account',
	picture: '/v2/update_pfp',
	twoFactor: '/v2/account_2fa',
	verifyEmail: '/v2/verify_email'
};

const EXTERNAL = {
	website: SITE + '/',
	privacy: SITE + '/privacy.html',
	terms: SITE + '/terms.html',
	source: 'https://github.com/zachduda/Empanadas.io-App',
	updates: SITE + '/updates'
};

function siteWindowOptions() {
	return {
		width: 1080,
		height: 780,
		minWidth: 600,
		minHeight: 480,
		title: 'Empanadas.io',
		backgroundColor: GAME_BACKGROUND,
		autoHideMenuBar: true,
		show: false,
		webPreferences: {
			preload: AUTH_PRELOAD,
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
			nodeIntegrationInSubFrames: false,
			webviewTag: false,
			webSecurity: true,
			allowRunningInsecureContent: false,
			experimentalFeatures: false,
			devTools: !app.isPackaged,
			zoomFactor: 1.0
		},
		icon: path.join(__dirname, 'icon.png')
	};
}

function openSiteWindow(url) {
	if (!isAppUrl(url)) return;
	for (const w of siteWindows) {
		if (!w.isDestroyed()) {
			w.loadURL(url).catch(() => {});
			w.show();
			w.focus();
			return;
		}
	}
	const w = new BrowserWindow(siteWindowOptions());
	siteWindows.add(w);
	siteContents.add(w.webContents);
	w.once('ready-to-show', () => w.show());
	setTimeout(() => { if (!w.isDestroyed() && !w.isVisible()) w.show(); }, 2000);
	w.on('closed', () => {
		siteWindows.delete(w);
		// The page may have changed the account (a new picture, a setting).
		sendToShell('refresh', { reason: 'site-window' });
	});
	w.webContents.on('did-navigate', (_event, url) => {
		if (isAppUrl(url) && /^\/v2\/auth\/logout(\.php)?$/.test(new URL(url).pathname)) {
			setImmediate(() => { if (!w.isDestroyed()) w.close(); });
			Promise.all([clearSiteCookies(session.defaultSession.cookies), clearSiteCookies(play.cookies)])
				.then(() => setAppCookie()).then(() => markSignedOut('signed_out'));
		}
	});
	w.loadURL(url).catch(() => {});
}

function openSitePage(name) {
	if (!Object.prototype.hasOwnProperty.call(SITE_PAGES, name)) return false;
	openSiteWindow(SITE + SITE_PAGES[name]);
	return true;
}

function siteWindowOf(contents) {
	const w = BrowserWindow.fromWebContents(contents);
	if (w && siteWindows.has(w)) return w;
	if (w && w.getParentWindow() && siteWindows.has(w.getParentWindow())) return w.getParentWindow();
	return null;
}

// Connecting Google/GitHub/Discord on the account page happens in the
// browser: the site sends the page to /v2/auth/browser?t=<ticket>, and the
// browser comes back with an empanadas-io://auth link (authRedeemUrl()).
const BROWSER_CONNECT_TTL = 10 * 60 * 1000;
let browserConnectAt = 0;

function startBrowserConnect(url) {
	browserConnectAt = Date.now();
	shell.openExternal(url).catch((err) =>
		console.warn('[auth] could not open the browser: ' + err.message));
}

function finishBrowserConnect(link) {
	const url = authRedeemUrl(link);
	if (!url) return;
	if (!browserConnectAt || Date.now() - browserConnectAt > BROWSER_CONNECT_TTL) {
		console.warn('[auth] ignored a sign-in link the app was not waiting for');
		return;
	}
	browserConnectAt = 0;
	closeAuthWindows();
	openSiteWindow(url);
}

function authWindowOptions() {
	return {
		width: 520,
		height: 720,
		minWidth: 400,
		minHeight: 480,
		title: 'Sign in',
		backgroundColor: '#ffffff',
		show: false,
		autoHideMenuBar: true,
		minimizable: false,
		maximizable: false,
		fullscreenable: false,
		webPreferences: {
			preload: AUTH_PRELOAD,
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
			nodeIntegrationInSubFrames: false,
			webviewTag: false,
			webSecurity: true,
			allowRunningInsecureContent: false,
			experimentalFeatures: false,
			devTools: false
		}
	};
}

function decorateAuthWindow(child) {
	authContents.add(child.webContents);
	if (child.setMenu) child.setMenu(null);
	const reveal = () => {
		if (!child.isDestroyed() && !child.isVisible()) child.show();
	};
	child.once('ready-to-show', reveal);
	setTimeout(reveal, 1500);
	child.setTitle('Sign in');
	child.on('page-title-updated', (event) => event.preventDefault());
}

function isSignInPopupRequest(url, disposition) {
	return isAuthUrl(url) || (isAppUrl(url) && disposition === 'new-window');
}

function closePopup(popupContents) {
	const popup = BrowserWindow.fromWebContents(popupContents);
	setImmediate(() => { if (popup && !popup.isDestroyed()) popup.close(); });
}

function closeAuthWindows() {
	for (const w of BrowserWindow.getAllWindows()) {
		if (!w.isDestroyed() && authContents.has(w.webContents)) w.close();
	}
}

function hasPage(contents) {
	const url = contents.getURL();
	return url !== '' && url !== 'about:blank';
}

let authWindow = null;

function openAuthWindow(url, parent) {
	if (authWindow && !authWindow.isDestroyed()) {
		authWindow.loadURL(url);
		authWindow.focus();
		return;
	}
	const options = authWindowOptions();
	if (parent && !parent.isDestroyed()) options.parent = parent;
	authWindow = new BrowserWindow(options);
	decorateAuthWindow(authWindow);
	authWindow.on('closed', () => { authWindow = null; });
	authWindow.loadURL(url);
}

// A sign-in popup finished on a page that belongs in the site window (the
// account page after linking GitHub), or one of the app's own screens.
function handOff(popupContents, url) {
	const parent = siteWindowOf(popupContents);
	const route = routes.siteRoute(url);
	if (route && route.screen === 'home') {
		if (parent && !parent.isDestroyed()) parent.close();
		goTo(route);
	} else if (parent && !parent.isDestroyed()) {
		parent.loadURL(url).catch(() => {});
		parent.focus();
	} else {
		openSiteWindow(url);
	}
	closePopup(popupContents);
}

function guardSite(contents) {
	const guard = (event, url, isRedirect, isMainFrame) => {
		if (isMainFrame && isBrowserSignInUrl(url)) {
			event.preventDefault();
			startBrowserConnect(url);
			if (authContents.has(contents)) closePopup(contents);
			return;
		}

		if (authContents.has(contents)) {
			if (!isPopupUrl(url)) {
				event.preventDefault();
				if (isMainFrame && /^https:\/\//i.test(url)) {
					shell.openExternal(url);
					if (!hasPage(contents)) closePopup(contents);
				}
				return;
			}
			if (isMainFrame && isHandoffUrl(url)) {
				event.preventDefault();
				handOff(contents, url);
			}
			return;
		}

		if (isAppUrl(url)) {
			if (!isMainFrame) return;
			// A page of the site's that the app has its own screen for (the
			// dashboard after verifying the address, a profile) closes the
			// window and shows that screen instead.
			const route = routes.siteRoute(url);
			if (route && !/^\/v2\/account(\/|\/index\.php)?$/.test(new URL(url).pathname)) {
				event.preventDefault();
				const w = siteWindowOf(contents);
				if (w && !w.isDestroyed()) setImmediate(() => w.close());
				goTo(route);
				return;
			}
			if (/^\/v2\/login(\.php)?$/.test(new URL(url).pathname)) {
				// Signed out meanwhile: the app's welcome screen signs in.
				event.preventDefault();
				const w = siteWindowOf(contents);
				if (w && !w.isDestroyed()) setImmediate(() => w.close());
				api.isSignedIn().then((still) => { if (still === false) markSignedOut('expired'); });
			}
			return;
		}
		event.preventDefault();
		if (!isMainFrame) return;

		if (isRedirect && isAuthUrl(url)) {
			openAuthWindow(url, siteWindowOf(contents));
		} else if (/^https:\/\//i.test(url) && !isSsoUrl(url)) {
			shell.openExternal(url);
		}
	};

	const mainFrame = (event, positional) =>
		typeof event.isMainFrame === 'boolean' ? event.isMainFrame : positional !== false;
	contents.on('will-navigate', (event, url, _isInPlace, isMainFrame) =>
		guard(event, url, false, mainFrame(event, isMainFrame)));
	contents.on('will-redirect', (event, url, _isInPlace, isMainFrame) =>
		guard(event, url, true, mainFrame(event, isMainFrame)));

	contents.setWindowOpenHandler(({ url, disposition }) => {
		// Only the site itself gets to raise a sign-in window, and a popup
		// cannot raise another one.
		const fromSite = isAppUrl(contents.getURL()) && !authContents.has(contents);

		if (fromSite && isBrowserSignInUrl(url)) {
			startBrowserConnect(url);
			return { action: 'deny' };
		}
		if (fromSite && isSignInPopupRequest(url, disposition)) {
			openingAuthWindow = true;
			setImmediate(() => { openingAuthWindow = false; });
			return {
				action: 'allow',
				outlivesOpener: false,
				overrideBrowserWindowOptions: authWindowOptions()
			};
		}
		if (fromSite && isAppUrl(url)) {
			followSiteLink(url);
		} else if (/^https:\/\//i.test(url) && !isAppUrl(url)) {
			shell.openExternal(url);
		}
		return { action: 'deny' };
	});
	contents.on('did-create-window', (child) => decorateAuthWindow(child));
}

// Every web contents the app makes gets the rules for what it is. Anything
// that is none of the app's (there should be nothing) can go nowhere.
app.on('web-contents-created', (_event, contents) => {
	if (openingAuthWindow) {
		openingAuthWindow = false;
		authContents.add(contents);
	}
	contents.on('will-attach-webview', (event) => event.preventDefault());

	// Decided once the contents is attached to something, which is after this
	// event: the creator adds it to siteContents or calls guardGame().
	setImmediate(() => {
		if (contents.isDestroyed()) return;
		if (siteContents.has(contents) || authContents.has(contents)) {
			guardSite(contents);
		} else if (win && !win.isDestroyed() && contents === win.webContents) {
			guardShell(contents);
		}
	});
});

// The app's own screens stay on app://shell: a link to the site goes through
// followSiteLink(), anything else to the browser.
function guardShell(contents) {
	const guard = (event, url) => {
		if (url.startsWith(SHELL_ORIGIN + '/')) return;
		event.preventDefault();
		if (isAppUrl(url)) followSiteLink(url);
		else if (/^https:\/\//i.test(url)) shell.openExternal(url);
	};
	contents.on('will-navigate', guard);
	contents.on('will-redirect', guard);
	contents.setWindowOpenHandler(({ url }) => {
		if (isAppUrl(url)) followSiteLink(url);
		else if (/^https:\/\//i.test(url)) shell.openExternal(url);
		return { action: 'deny' };
	});
}

// --- The window --------------------------------------------------------------

const WINDOW_STATE_FILE = () => path.join(app.getPath('userData'), 'window-state.json');

function titleBarOverlay() {
	const dark = nativeTheme.shouldUseDarkColors;
	return { color: dark ? '#17172b' : '#eeeef6', symbolColor: dark ? '#f2f2ff' : '#1b1b3a', height: TITLEBAR_HEIGHT };
}

function windowBackground() {
	return nativeTheme.shouldUseDarkColors ? '#17172b' : '#f6f6fb';
}

// The loading screen's blue (Content/Loading/loading.css --bg), under the
// Windows caption buttons too while it shows.
const LOADING_BACKGROUND = '#1e1e91';

function loadingTitleBarOverlay() {
	return { color: LOADING_BACKGROUND, symbolColor: '#ffffff', height: TITLEBAR_HEIGHT };
}

function showingShell() {
	return !!win && !win.isDestroyed() && !win.webContents.isLoading() && win.webContents.getURL().startsWith(SHELL_ORIGIN + '/');
}

function sendToShell(channel, payload) {
	if (!showingShell()) return false;
	win.webContents.send('native:' + channel, payload);
	return true;
}

// --- The loading screen -------------------------------------------------------
// What the window shows at launch while the screens' files are checked
// against the site's (lib/resources.js): Content/Loading/, the splash of the
// 1.x app. It is told how the check goes ('native:loading'), and the screens
// load once the check is done, or has had RESOURCES_WAIT.

function setLoading(state) {
	loadingState = Object.assign({}, state);
	if (win && !win.isDestroyed() && win.webContents.getURL().startsWith(LOADING_ORIGIN + '/')) {
		win.webContents.send('native:loading', loadingState);
	}
}

function startupCheck() {
	if (!startup) {
		startup = (async () => {
			const began = Date.now();
			let result = null;
			if (resources.status().enabled) {
				setLoading({ phase: 'checking' });
				const check = resources.check((p) => setLoading(p));
				result = await Promise.race([check, wait(RESOURCES_WAIT).then(() => null)]);
			}
			if (!result) {
				setLoading({ phase: resources.status().enabled ? 'slow' : 'done' });
			} else if (result.status === 'failed' && !net.isOnline()) {
				setLoading({ phase: 'offline' });
			} else {
				setLoading({ phase: 'done', status: result.status });
			}
			resources.begin();
			await wait(Math.max(0, LOADING_MIN - (Date.now() - began)));
		})().catch((err) => {
			console.warn('[resources] ' + err.message);
			resources.begin();
		});
	}
	return startup;
}

// Leaves the loading screen for the screens.
async function loadShell(target) {
	if (!target || target.isDestroyed()) return;
	if (target.webContents.getURL().startsWith(LOADING_ORIGIN + '/')) {
		setLoading({ phase: 'leaving' });
		await wait(280);
		if (target.isDestroyed()) return;
	}
	if (isWindows) target.setTitleBarOverlay(titleBarOverlay());
	if (!isMac) target.setBackgroundColor(windowBackground());
	shellReady = false;
	clearTimeout(readyTimer);
	const fromSite = resources.begin();
	if (fromSite) {
		// Screens from the site that never say they are up (a bad deploy, a
		// file missing): the app's own, and that set is never tried again.
		readyTimer = setTimeout(() => {
			if (shellReady || target.isDestroyed() || target !== win) return;
			if (resources.markBad(fromSite)) target.loadURL(SHELL_URL).catch(() => {});
		}, SHELL_READY_WAIT);
	}
	target.loadURL(SHELL_URL).catch(() => {});
}

function wait(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function showWindow() {
	if (bg) return;
	if (!win || win.isDestroyed()) {
		if (app.isReady()) createShellWindow();
		return;
	}
	if (win.isMinimized()) win.restore();
	win.show();
	win.focus();
}

function createShellWindow({ playOnLoad } = {}) {
	if (playOnLoad) pendingPlay = playOnLoad;
	const firstLoad = !startup;
	const placed = windowState.place(
		windowState.load(WINDOW_STATE_FILE()),
		screen.getAllDisplays().map((d) => d.workArea),
		screen.getPrimaryDisplay().workArea,
		{ width: 1180, height: 780, minWidth: 880, minHeight: 580 });

	const options = {
		width: placed.width,
		height: placed.height,
		x: placed.x,
		y: placed.y,
		minWidth: placed.minWidth,
		minHeight: placed.minHeight,
		title: 'Empanadas.io',
		show: false,
		backgroundColor: firstLoad ? LOADING_BACKGROUND : windowBackground(),
		icon: path.join(__dirname, 'icon.png'),
		webPreferences: {
			preload: SHELL_PRELOAD,
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
			nodeIntegrationInSubFrames: false,
			webviewTag: false,
			webSecurity: true,
			allowRunningInsecureContent: false,
			experimentalFeatures: false,
			spellcheck: false,
			devTools: !app.isPackaged
		}
	};
	if (isMac) {
		// The system's own title bar buttons, inset into the app's title bar,
		// and the translucent sidebar material Finder and Mail use.
		Object.assign(options, {
			titleBarStyle: 'hiddenInset',
			trafficLightPosition: { x: 16, y: 15 },
			vibrancy: 'sidebar',
			visualEffectState: 'followWindow',
			backgroundColor: '#00000000'
		});
	} else if (isWindows) {
		// The system's own minimize, maximize and close (with Snap Layouts),
		// drawn over the app's title bar.
		Object.assign(options, { titleBarStyle: 'hidden', titleBarOverlay: firstLoad ? loadingTitleBarOverlay() : titleBarOverlay() });
	} else {
		options.autoHideMenuBar = true;
	}

	win = new BrowserWindow(options);
	const self = win;
	if (placed.maximized) win.maximize();

	win.once('ready-to-show', () => { if (!self.isDestroyed()) self.show(); });
	setTimeout(() => { if (!self.isDestroyed() && !self.isVisible() && !bg) self.show(); }, 3000);

	win.on('close', (event) => {
		if (self.isDestroyed()) return;
		if (handingOff) {
			event.preventDefault();
			return;
		}
		windowState.save(WINDOW_STATE_FILE(), Object.assign({}, self.getNormalBounds(), { maximized: self.isMaximized() }));
		if (game && !closingForReal) {
			event.preventDefault();
			if (shouldKeepSpinning()) {
				handOffToBackground();
				return;
			}
			closeGame().finally(() => {
				closingForReal = true;
				if (!self.isDestroyed()) self.close();
				if (quitting) app.quit();
			});
		}
	});
	win.on('closed', () => {
		if (win === self) win = null;
		closingForReal = false;
	});

	const relayout = () => { layoutGame(); };
	win.on('resize', relayout);
	win.on('enter-full-screen', () => { relayout(); sendToShell('window', { fullscreen: true }); });
	win.on('leave-full-screen', () => {
		gameFullscreen = false;
		relayout();
		sendToShell('window', { fullscreen: false });
		sendGameState();
	});
	win.on('focus', () => sendToShell('window', { focused: true }));
	win.on('blur', () => sendToShell('window', { focused: false }));

	win.webContents.on('did-finish-load', () => {
		if (!self.webContents.getURL().startsWith(SHELL_ORIGIN + '/')) return;
		if (pendingRoute) {
			const route = pendingRoute;
			pendingRoute = null;
			setTimeout(() => goTo(route), 50);
		}
		if (pendingPlay) {
			const name = pendingPlay;
			pendingPlay = null;
			setTimeout(() => playGame(name), 50);
		}
	});
	win.webContents.on('render-process-gone', (_event, details) => {
		if (!details || details.reason === 'clean-exit' || self.isDestroyed()) return;
		console.warn('[window] the app\'s page went away: ' + details.reason);
		// Screens from the site that crash before they are up are not tried again.
		if (!shellReady && resources.status().serving) resources.markBad();
		loadShell(self);
	});

	if (firstLoad) {
		win.loadURL(LOADING_URL).catch(() => {});
		startupCheck().then(() => loadShell(self));
	} else {
		startup.then(() => loadShell(self));
	}
	return win;
}

function applyTheme(value) {
	const source = ['system', 'light', 'dark'][value] || 'system';
	if (nativeTheme.themeSource !== source) nativeTheme.themeSource = source;
	if (prefs && prefs.get().theme !== value) prefs.set({ theme: value });
}

// --- Keep Spinning When Closed ---------------------------------------------
// lib/background.js has the rules; this is the Electron half: the hand-over
// from the game, the save requests, the tray, and the process priority.

const OPEN_SPIN_ARG = '--open-spin-game';

function backgroundAvailable() {
	return background.supported(process.platform) && !!backgroundSettings;
}

function backgroundStatus() {
	const available = backgroundAvailable();
	return { available, enabled: available && backgroundSettings.enabled() };
}

function setBackgroundEnabled(value) {
	if (!backgroundAvailable()) return backgroundStatus();
	backgroundSettings.set(value === true);
	buildAppMenu();
	sendToShell('background', backgroundStatus());
	return backgroundStatus();
}

function shouldKeepSpinning() {
	return backgroundStatus().enabled && !quitting && !bg && !!game && game.name === 'spin' && !game.closing;
}

// window.spinBackgroundHandoff() and spinBackgroundResume() are the Spin
// Game's (_spin.js in the Empanadas-io repo). A game from before them answers
// null, and closes as it always has.
const HANDOFF_SCRIPT = "typeof window.spinBackgroundHandoff === 'function' ? window.spinBackgroundHandoff() : null";
const RESUME_SCRIPT = "typeof window.spinBackgroundResume === 'function' ? window.spinBackgroundResume() : null";

// One save to updatedata.php, with the account's cookies and the game's user
// agent (the site ties a session to the browser that signed in). Resolves
// { status, body } or null for no answer.
function postSave(fields, ua) {
	return new Promise((resolve) => {
		let done = false;
		let timer = null;
		const finish = (value) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve(value);
		};
		let req;
		try {
			req = net.request({
				method: 'POST',
				url: SITE + '/v2/updatedata.php',
				session: session.defaultSession,
				useSessionCookies: true,
				origin: SITE,
				redirect: 'error',
				cache: 'no-store'
			});
			req.setHeader('Content-Type', 'application/x-www-form-urlencoded');
			if (ua) req.setHeader('User-Agent', ua);
		} catch (err) {
			finish(null);
			return;
		}
		timer = setTimeout(() => {
			try { req.abort(); } catch (err) { /* already over */ }
			finish(null);
		}, 20 * 1000);
		req.on('response', (res) => {
			const chunks = [];
			let size = 0;
			res.on('data', (chunk) => {
				size += chunk.length;
				if (size <= 256 * 1024) chunks.push(chunk);
			});
			res.on('end', () => finish({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
			res.on('error', () => finish(null));
		});
		req.on('error', () => finish(null));
		req.on('abort', () => finish(null));
		req.end(background.formBody(fields));
	});
}

// Closing the window during Spin with the setting on. The game hands over its
// state and stops; that save is posted, and only once it has landed do the
// window and the game go and the tray take over. Anything else (an older
// game, nothing for Auto Spinners to do, offline, a refused save) closes as
// it would have.
async function handOffToBackground() {
	if (!game || !win) return;
	handingOff = true;
	let started = false;
	const contents = game.view.webContents;
	try {
		const handoff = background.cleanHandoff(
			await withTimeout(contents.executeJavaScript(HANDOFF_SCRIPT, true).catch(() => null), 3000));
		if (handoff && net.isOnline() && !contents.isDestroyed()) {
			const ua = contents.getUserAgent();
			const first = background.judgeReply(await postSave(background.saveFields(handoff.save), ua));
			if (first.action === 'ok' && !quitting) {
				startBackground(handoff, ua);
				started = true;
			} else {
				console.warn('[background] the game was not handed over: ' + (first.why || first.action));
			}
		}
		if (!started && handoff && !contents.isDestroyed()) {
			await withTimeout(contents.executeJavaScript(RESUME_SCRIPT, true).catch(() => null), 1000);
		}
	} catch (err) {
		console.warn('[background] ' + err.message);
	} finally {
		handingOff = false;
	}
	if (started) {
		// The game already saved: no need to let it unload.
		const g = game;
		game = null;
		if (win && !win.isDestroyed()) {
			win.contentView.removeChildView(g.view);
			win.destroy();
		}
		if (!g.view.webContents.isDestroyed()) g.view.webContents.close();
	} else if (win && !win.isDestroyed()) {
		await closeGame();
		closingForReal = true;
		if (win && !win.isDestroyed()) win.close();
	}
}

function trayIcon() {
	const source = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
	const icon = source.resize({ width: 16, height: 16, quality: 'best' });
	icon.addRepresentation({
		scaleFactor: 2,
		buffer: source.resize({ width: 32, height: 32, quality: 'best' }).toPNG()
	});
	return icon;
}

function drawTray(view) {
	if (!bg || !bg.tray || bg.tray.isDestroyed()) return;
	const spins = background.spinsLabel(view.spins);
	const status = background.statusLabel(view);
	bg.tray.setToolTip('Empanadas.io: ' + spins + '\n' + status);
	if (isMac) bg.tray.setTitle(background.addCommas(view.spins), { fontType: 'monospacedDigit' });
	bg.tray.setContextMenu(Menu.buildFromTemplate([
		{ label: spins, enabled: false },
		{ label: status, enabled: false },
		{ type: 'separator' },
		{ label: 'Open Spin Game', click: () => leaveBackground({ open: true }) },
		{ label: 'Quit Empanadas.io', click: () => leaveBackground({ quit: true }) }
	]));
}

// The app's own processes at the lowest priority while in the tray, and back
// to normal after. Returns false when one could not be put back: a Mac only
// lets a process be made less important, never more, without admin rights.
function setAppPriority(priority) {
	let ok = true;
	const pids = new Set([process.pid]);
	try {
		for (const metric of app.getAppMetrics()) if (metric && metric.pid) pids.add(metric.pid);
	} catch (err) {
		// The main process alone, then.
	}
	for (const pid of pids) {
		try {
			os.setPriority(pid, priority);
		} catch (err) {
			if (err && err.code !== 'ESRCH') ok = false;
		}
	}
	return ok;
}

function startBackground(handoff, ua) {
	bg = { tray: new Tray(trayIcon()), runner: null, leaving: false };
	if (!isMac) bg.tray.on('click', () => leaveBackground({ open: true }));
	bg.runner = background.createRunner(handoff, {
		post: (fields) => postSave(fields, ua),
		wall: () => Date.now(),
		mono: () => performance.now(),
		load: background.createLoadMeter(process.platform),
		online: () => net.isOnline(),
		onChange: drawTray,
		onStop: (why) => {
			if (why === 'won') notify('Ready to Prestige!', 'Your Auto Spinners reached 100,000 Spins. Open the Spin Game to Prestige.', { play: 'spin' });
		},
		onOverload: () => {
			console.warn('[background] the computer has been busy too long: saving and quitting');
			leaveBackground({ quit: true });
		}
	});
	updater.stop();
	setAppPriority(os.constants.priority.PRIORITY_LOW);
	if (isMac && app.dock) app.dock.hide();
}

async function leaveBackground(opts) {
	if (!bg || bg.leaving) return;
	const b = bg;
	b.leaving = true;
	try {
		await withTimeout(b.runner.flush(), opts.quit ? 5000 : 10000);
	} catch (err) {
		// At most a minute of spins.
	}
	b.runner.stop();
	if (!b.tray.isDestroyed()) b.tray.destroy();
	bg = null;

	if (opts.quit) {
		quitting = true;
		app.quit();
		return;
	}
	if (!setAppPriority(os.constants.priority.PRIORITY_NORMAL)) {
		const args = process.argv.slice(1).filter((arg) => arg !== OPEN_SPIN_ARG);
		app.relaunch({ args: args.concat([OPEN_SPIN_ARG]) });
		app.exit(0);
		return;
	}
	if (isMac && app.dock) app.dock.show();
	updater.start();
	createShellWindow({ playOnLoad: 'spin' });
}

// --- Cache -------------------------------------------------------------------

// Empties the network and code caches of both sessions and the kept
// pictures. Never cookies, the saves (localStorage) or the kept games.
async function clearAppCache() {
	const results = await Promise.allSettled([
		...[session.defaultSession, play].flatMap((ses) => [
			ses.clearCache(),
			ses.clearCodeCaches({}),
			ses.clearStorageData({ storages: ['shadercache'] }),
			ses.clearHostResolverCache()
		]),
		images.clear()
	]);
	const failed = results.filter((r) => r.status === 'rejected');
	for (const r of failed) console.warn('[cache] could not clear part of the cache: ' + (r.reason && r.reason.message));
	return { ok: failed.length === 0 };
}

async function dirSize(dir) {
	let entries;
	try {
		entries = await fs.promises.readdir(dir, { withFileTypes: true });
	} catch {
		return 0;
	}
	const sizes = await Promise.all(entries.map(async (entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) return dirSize(full);
		if (!entry.isFile()) return 0;
		try {
			return (await fs.promises.stat(full)).size;
		} catch {
			return 0;
		}
	}));
	return sizes.reduce((a, b) => a + b, 0);
}

async function appCacheSize() {
	const sizes = await Promise.all([session.defaultSession, play].map(async (ses) => {
		const base = ses.getStoragePath() || app.getPath('userData');
		const parts = await Promise.all([
			ses.getCacheSize().catch(() => 0),
			dirSize(path.join(base, 'Code Cache')),
			dirSize(path.join(base, 'GPUCache')),
			dirSize(path.join(base, 'DawnGraphiteCache')),
			dirSize(path.join(base, 'DawnWebGPUCache'))
		]);
		return parts.reduce((a, b) => a + b, 0);
	}));
	return { bytes: sizes.reduce((a, b) => a + b, 0) + await images.size() };
}

// --- IPC ---------------------------------------------------------------------

function isShellSender(event) {
	try {
		const url = (event.senderFrame && event.senderFrame.url) || '';
		return !!win && !win.isDestroyed() && event.sender === win.webContents && url.startsWith(SHELL_ORIGIN + '/');
	} catch (err) {
		return false;
	}
}

function isGameSender(event) {
	try {
		const url = (event.senderFrame && event.senderFrame.url) || '';
		return !!game && event.sender === game.view.webContents && isAppUrl(url);
	} catch (err) {
		return false;
	}
}

function registerIpcHandlers() {
	const handle = (channel, fn, trusted = isShellSender) => {
		ipcMain.handle(channel, (event, ...args) => {
			if (!trusted(event)) {
				console.warn('[ipc] refused ' + channel + ' from ' + (event.senderFrame ? event.senderFrame.url : 'unknown'));
				return null;
			}
			return fn(...args);
		});
	};
	const either = (event) => isShellSender(event) || isGameSender(event);

	const isLoadingSender = (event) => {
		try {
			const url = (event.senderFrame && event.senderFrame.url) || '';
			return !!win && !win.isDestroyed() && event.sender === win.webContents && url.startsWith(LOADING_ORIGIN + '/');
		} catch (err) {
			return false;
		}
	};
	handle('loading:state', () => Object.assign({ version: app.getVersion() }, loadingState), isLoadingSender);
	handle('shell:ready', () => {
		shellReady = true;
		clearTimeout(readyTimer);
		readyTimer = null;
		return true;
	});
	handle('resources:status', () => resources.status());

	handle('app:info', () => ({
		version: app.getVersion(), platform: process.platform, isMac, isWindows,
		packaged: app.isPackaged, titlebar: TITLEBAR_HEIGHT
	}));

	handle('session:get', () => sessionInfo());
	handle('session:signIn', (mode) => startSignIn(mode));
	handle('session:cancelSignIn', () => cancelSignIn());
	handle('session:signOut', () => signOut());

	handle('data:cached', (key, params) => cachedScreen(String(key), params && typeof params === 'object' ? params : {}));
	handle('data:load', (key, params) => loadScreen(String(key), params && typeof params === 'object' ? params : {}));
	handle('data:act', (action, params) => act(String(action), params));

	handle('game:play', (name) => playGame(String(name)));
	handle('game:close', () => closeGame());
	handle('game:show', () => showGame());
	handle('game:state', () => gameState());
	handle('games:status', () => gamesStatus());
	handle('games:update', () => bundle.sync().then(() => gamesStatus()));
	handle('games:clear', async () => {
		await closeGame();
		await bundle.clear();
		if (net.isOnline()) bundle.sync();
		return gamesStatus();
	});

	handle('site:open', (name) => openSitePage(String(name)));
	handle('external:open', (name) => {
		const url = EXTERNAL[String(name)];
		if (url) shell.openExternal(url);
		return !!url;
	});

	handle('background-status', () => backgroundStatus(), either);
	handle('background-set', (value) => setBackgroundEnabled(value === true), either);

	handle('update-check', () => updater.checkFromRenderer());
	handle('update-state', () => updater.getState());

	handle('cache:size', () => appCacheSize());
	handle('cache:clear', () => clearAppCache());

	handle('prefs:get', () => prefs.get());
	handle('prefs:set', (patch) => {
		const clean = {};
		if (patch && typeof patch.notifications === 'boolean') clean.notifications = patch.notifications;
		return prefs.set(clean);
	});
	handle('theme:set', (value) => {
		const v = Math.floor(Number(value));
		if (v >= 0 && v <= 2) applyTheme(v);
		return { theme: prefs.get().theme, dark: nativeTheme.shouldUseDarkColors };
	});
	handle('theme:get', () => ({ theme: prefs.get().theme, dark: nativeTheme.shouldUseDarkColors }));

	// A native context menu: items are [{ id, label, enabled?, type? }].
	handle('menu:popup', (items) => new Promise((resolve) => {
		if (!Array.isArray(items) || !win) {
			resolve(null);
			return;
		}
		let chosen = null;
		const template = items.slice(0, 20).map((item) => item && item.type === 'separator'
			? { type: 'separator' }
			: { label: String((item && item.label) || '').slice(0, 80), enabled: !(item && item.enabled === false), click: () => { chosen = item.id; } });
		Menu.buildFromTemplate(template).popup({ window: win, callback: () => setImmediate(() => resolve(chosen)) });
	}));

	handle('window:toggleFullscreen', () => {
		if (win) win.setFullScreen(!win.isFullScreen());
		return win ? win.isFullScreen() : false;
	});
	handle('window:state', () => ({ fullscreen: !!(win && win.isFullScreen()), focused: !!(win && win.isFocused()) }));
	handle('window:zoom', () => {
		// A double-click on a title bar, as the system's own does.
		if (!win) return;
		if (isMac) {
			const action = systemPreferences.getUserDefault('AppleActionOnDoubleClick', 'string');
			if (action === 'Minimize') { win.minimize(); return; }
			if (action === 'None') return;
		}
		if (win.isMaximized()) win.unmaximize();
		else win.maximize();
	});
	handle('net:online', () => {
		if (isSignedIn() && Date.now() - bundle.status().syncedAt > 60 * 60 * 1000) scheduleBundleSync(1000);
		sendToShell('games', gamesStatus());
		return true;
	});
}

// --- Menus, the Dock and the jump list --------------------------------------

function quickPlayOrder() {
	const history = playHistory ? playHistory.get() : {};
	return Object.keys(gamebundle.GAMES).sort((a, b) => (history[b] || 0) - (history[a] || 0));
}

function linkArguments(link) {
	return process.defaultApp ? '"' + path.resolve(process.argv[1]) + '" ' + link : link;
}

function updateQuickPlay() {
	const signedIn = isSignedIn();
	const order = quickPlayOrder();
	try {
		if (isMac && app.dock) {
			app.dock.setMenu(Menu.buildFromTemplate(signedIn ? order.map((name) => ({
				label: 'Play ' + GAME_TITLES[name], click: () => playGame(name)
			})) : []));
		}
		if (isWindows) {
			app.setUserTasks(signedIn ? order.map((name) => ({
				program: process.execPath,
				arguments: linkArguments('empanadas-io://play/' + name),
				iconPath: process.execPath,
				iconIndex: 0,
				title: 'Play ' + GAME_TITLES[name],
				description: 'Open ' + GAME_TITLES[name] + ' in Empanadas.io'
			})) : []);
		}
	} catch (err) {
		// Not worth failing anything over.
	}
}

function buildAppMenu() {
	const signedIn = isSignedIn();
	const go = (screen) => () => goTo({ screen });
	const sep = { type: 'separator' };
	const mod = isMac ? 'Cmd' : 'Ctrl';

	const appItems = [
		{ label: 'Settings…', accelerator: mod + '+,', enabled: signedIn, click: go('settings') },
		{ label: 'Check for Updates…', click: () => updater.checkFromRenderer() },
		sep,
		{
			// The same setting as the switch in Settings and in the Spin
			// Game's own settings.
			label: 'Keep Spinning When Closed',
			type: 'checkbox',
			checked: backgroundStatus().enabled,
			enabled: backgroundAvailable(),
			click: (item) => setBackgroundEnabled(item.checked)
		}
	];

	const template = [];
	if (isMac) {
		template.push({
			label: app.getName(),
			submenu: [
				{ role: 'about' }, sep, ...appItems, sep,
				{ role: 'services' }, sep,
				{ role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, sep,
				{ role: 'quit' }
			]
		});
	} else {
		template.push({ label: 'File', submenu: [...appItems, sep, { role: 'quit' }] });
	}
	template.push({
		label: 'Edit',
		submenu: [{ role: 'undo' }, { role: 'redo' }, sep, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }]
	});
	template.push({
		label: 'View',
		// No togglefullscreen role: macOS adds its own Enter Full Screen here,
		// and the role item showed twice.
		submenu: [
			{ label: 'Refresh', accelerator: mod + '+R', click: () => sendToShell('refresh', { reason: 'menu' }) },
			...(isMac ? [] : [{ label: 'Full Screen', accelerator: 'F11', click: () => { if (win) win.setFullScreen(!win.isFullScreen()); } }]),
			sep,
			{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
			...(app.isPackaged ? [] : [sep, { role: 'toggleDevTools' }])
		]
	});
	template.push({
		label: 'Go',
		submenu: [
			{ label: 'Back', accelerator: mod + '+[', click: () => (game && !game.hidden ? closeGame() : sendToShell('back', {})) },
			sep,
			{ label: 'Home', accelerator: mod + '+1', enabled: signedIn, click: go('home') },
			{ label: 'Games', accelerator: mod + '+2', enabled: signedIn, click: go('games') },
			{ label: 'Leaderboards', accelerator: mod + '+3', enabled: signedIn, click: go('leaderboard') },
			{ label: 'Friends', accelerator: mod + '+4', enabled: signedIn, click: go('friends') },
			{ label: 'My Profile', accelerator: mod + '+5', enabled: signedIn, click: go('profile') },
			{ label: 'Updates', enabled: signedIn, click: go('updates') },
			sep,
			{ label: 'Find Friends…', accelerator: mod + '+F', enabled: signedIn, click: () => goTo({ screen: 'friends', search: true }) },
			sep,
			...quickPlayOrder().map((name) => ({
				label: 'Play ' + GAME_TITLES[name],
				accelerator: mod + '+Shift+' + (Object.keys(gamebundle.GAMES).indexOf(name) + 1),
				enabled: signedIn,
				click: () => playGame(name)
			}))
		]
	});
	template.push({
		label: 'Window',
		submenu: [
			{ role: 'minimize' },
			...(isMac ? [{ role: 'zoom' }] : []),
			{ label: 'Close', accelerator: mod + '+W', click: () => (game && !game.hidden ? closeGame() : win && win.close()) },
			...(isMac ? [sep, { role: 'front' }] : [])
		]
	});
	template.push({
		role: 'help',
		submenu: [
			{ label: 'Send Feedback…', enabled: signedIn, click: go('feedback') },
			sep,
			{ label: 'Empanadas.io Website', click: () => shell.openExternal(EXTERNAL.website) },
			{ label: 'Privacy Policy', click: () => shell.openExternal(EXTERNAL.privacy) },
			{ label: 'Terms of Service', click: () => shell.openExternal(EXTERNAL.terms) }
		]
	});
	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- Starting and stopping -----------------------------------------------------

let migration = null;
if (gotTheLock) migration = migrateFromWebShell();

app.on('ready', () => {
	if (!gotTheLock) return;
	const userData = app.getPath('userData');
	accountState = jsonfile.createStore(path.join(userData, 'account.json'), { signedIn: false, username: '' });
	prefs = jsonfile.createStore(path.join(userData, 'prefs.json'), { theme: 0, notifications: true });
	playHistory = jsonfile.createStore(path.join(userData, 'play-history.json'), {});
	pendingSignIn = signin.createPendingStore(path.join(userData, 'signin.json'));
	backgroundSettings = background.createSettings(path.join(userData, 'background.json'));

	// The web-wrapper app's player was signed in: carry on as them, and let
	// the site say otherwise.
	if (migration && migration.firstRun && migration.hadSignIn) accountState.set({ signedIn: true });
	applyTheme(Number(prefs.get().theme) || 0);

	setUpSessions();
	if (migration && migration.firstRun) {
		// The site's offline worker the web-wrapper app registered: the games
		// are kept by the app itself now.
		session.defaultSession.clearStorageData({ origin: SITE, storages: ['serviceworkers', 'cachestorage'] })
			.catch((err) => console.warn('[migrate] could not remove the old offline games: ' + err.message));
	}

	registerIpcHandlers();
	buildAppMenu();
	updateQuickPlay();

	nativeTheme.on('updated', () => {
		if (win && !win.isDestroyed() && !win.webContents.getURL().startsWith(LOADING_ORIGIN + '/')) {
			if (isWindows) win.setTitleBarOverlay(titleBarOverlay());
			if (!isMac) win.setBackgroundColor(windowBackground());
		}
		sendToShell('theme', { dark: nativeTheme.shouldUseDarkColors, theme: prefs.get().theme });
	});

	createShellWindow({ playOnLoad: process.argv.includes(OPEN_SPIN_ARG) ? 'spin' : undefined });
	updater.setWindowProvider(() => win);
	updater.start();
	startBundleSchedule();
	startDashboardPoll();

	// Is the session the app believes in still good? Asked once at launch.
	if (isSignedIn()) {
		api.isSignedIn().then((still) => { if (still === false) markSignedOut('expired'); });
	}

	powerMonitor.on('suspend', () => { if (bg) bg.runner.pause(); });
	powerMonitor.on('resume', () => {
		if (bg) bg.runner.resume();
		else if (isSignedIn()) scheduleBundleSync(5000);
	});
});

app.on('activate', () => {
	if (!gotTheLock || !app.isReady()) return;
	if (bg) {
		leaveBackground({ open: true });
		return;
	}
	showWindow();
});

app.on('before-quit', (event) => {
	if (bg && !bg.leaving) {
		event.preventDefault();
		leaveBackground({ quit: true });
		return;
	}
	quitting = true;
	if (bundle) bundle.flush();
});

app.on('window-all-closed', () => {
	// Not while the game is in the tray, or on its way there.
	if (!isMac && !bg && !handingOff) app.quit();
});
