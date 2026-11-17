const {app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, net, Notification, powerMonitor, screen, shell, session, systemPreferences, Tray} = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const updater = require('./updater');
const isMac = process.platform === 'darwin';

const {
	isAppUrl, isAuthUrl, isSsoUrl, isPopupUrl, isHandoffUrl,
	isBrowserSignInUrl, isAuthDeepLink, authRedeemUrl, browserUserAgent,
	APP_HOST, AUTH_HOSTS
} = require('./lib/urls');
const offline = require('./lib/offline');
const windowState = require('./lib/windowstate');
const background = require('./lib/background');

const SPLASH_URL = require('url').pathToFileURL(path.join(__dirname, 'download.html')).href;

function isSplashUrl(url) {
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'file:' && parsed.origin + parsed.pathname ===
			new URL(SPLASH_URL).origin + new URL(SPLASH_URL).pathname;
	} catch (err) {
		return false;
	}
}

function isTrustedSender(event) {
	let url = '';
	try {
		url = (event.senderFrame && event.senderFrame.url) || '';
	} catch (err) {
		return false;
	}
	return isAppUrl(url) || isSplashUrl(url);
}

let offlineStore = null;
app.commandLine.appendSwitch('disable-webgl')
app.commandLine.appendSwitch('disable-webgl2')

// buildAppMenu() leaves Full Screen to the item macOS adds to the View menu
// itself. NSFullScreenMenuItemEverywhere = NO stops macOS adding it, and stays
// in the app's preferences once set: older Electron releases set it on every
// launch, and so did an earlier attempt at this fix.
if (isMac) systemPreferences.removeUserDefault('NSFullScreenMenuItemEverywhere');

let win;

// Keep Spinning When Closed (lib/background.js). bg is set while the app is in
// the tray with the game closed: { tray, runner, leaving }.
let bg = null;
let backgroundSettings = null;
let handingOff = false;
let quitting = false;
// Windows that are to close the ordinary way, without going to the tray.
const closingForReal = new WeakSet();
// A Mac cannot raise a process's priority back once it has lowered it, so it
// starts again instead, and this tells the new one to open the Spin Game.
const OPEN_SPIN_ARG = '--open-spin-game';

app.enableSandbox();

if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('empanadas-io', process.execPath, [path.resolve(process.argv[1])])
  }
} else {
  app.setAsDefaultProtocolClient('empanadas-io')
}

let pendingDeepLink = null;

function handleDeepLink(url) {
	if (typeof url !== 'string' || !url.startsWith('empanadas-io:')) return;
	if (url.length > 2048) return;
	try {
		if (new URL(url).protocol !== 'empanadas-io:') return;
	} catch (err) {
		return;
	}

	if (isAuthDeepLink(url)) {
		finishBrowserSignIn(url);
		return;
	}

	// In the tray: the game opens again, and gets the link once it has loaded.
	if (bg) {
		pendingDeepLink = url;
		leaveBackground({ open: true });
		return;
	}

	if (win && !win.isDestroyed() && isAppUrl(win.webContents.getURL())) {
		if (win.isMinimized()) win.restore();
		win.focus();
		win.webContents.send('deep-link', url);
	} else {
		pendingDeepLink = url;
		// macOS keeps the app running with its window closed: open one, or
		// the link goes nowhere. It is delivered once the site has loaded.
		if (app.isReady() && (!win || win.isDestroyed())) createDefaultWindow();
	}
}

const BROWSER_SIGNIN_TTL = 10 * 60 * 1000;

let browserSignInAt = 0;

function startBrowserSignIn(url) {
	browserSignInAt = Date.now();
	shell.openExternal(url).catch((err) =>
		console.warn('[auth] could not open the browser to sign in: ' + err.message));
}

function finishBrowserSignIn(link) {
	const url = authRedeemUrl(link);
	if (!url) return;
	if (!browserSignInAt || Date.now() - browserSignInAt > BROWSER_SIGNIN_TTL) {
		console.warn('[auth] ignored a sign-in link the app was not waiting for');
		return;
	}
	browserSignInAt = 0;
	closeAuthWindows();

	if (!win || win.isDestroyed()) createDefaultWindow();
	if (win.isMinimized()) win.restore();
	win.show();
	win.focus();
	if (isMac) app.focus({ steal: true });
	win.loadURL(url).catch(() => {});
}

const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
	app.quit()
	} else {
	  app.on('second-instance', (event, commandLine, workingDirectory) => {
		// Launched again while spinning in the tray: open the game.
		if (bg && !commandLine.some((arg) => typeof arg === 'string' && arg.startsWith('empanadas-io:'))) {
			leaveBackground({ open: true });
			return;
		}
		if (win) {
		  if (win.isMinimized()) win.restore()
		  win.focus()
		}
		handleDeepLink(commandLine.find((arg) => arg.startsWith('empanadas-io:')));
	})
	handleDeepLink(process.argv.find((arg) => typeof arg === 'string' && arg.startsWith('empanadas-io:')));
}

app.on('open-url', (event, url) => {
	event.preventDefault();
	handleDeepLink(url);
});

function lockDownPermissions() {
	const ALLOWED = new Set(['fullscreen', 'pointerLock']);

	const ses = session.defaultSession;

	ses.setPermissionRequestHandler((contents, permission, callback, details) => {
		const origin = (details && details.requestingUrl) || contents.getURL();
		callback(ALLOWED.has(permission) && isAppUrl(origin));
	});

	ses.setPermissionCheckHandler((contents, permission, origin) =>
		ALLOWED.has(permission) && isAppUrl(origin));

	ses.setDevicePermissionHandler(() => false);
	if (ses.setBluetoothPairingHandler) ses.setBluetoothPairingHandler(() => {});
}

let cspReported = false;

function reportMissingCsp(details) {
	const isPageLoad = details.resourceType === 'mainFrame' && isAppUrl(details.url);

	if (isPageLoad && !cspReported) {
		const headers = details.responseHeaders || {};
		const has = Object.keys(headers).some((name) =>
			name.toLowerCase() === 'content-security-policy');
		if (!has) {
			cspReported = true;
			console.warn(
				'[security] ' + details.url + ' served no Content-Security-Policy ' +
				'header. See "Site headers" in SECURITY.md for the recommended set.');
		}
	}
}

function watchResponses() {
	// Only the site's own responses say anything here. Unfiltered, every
	// response of every page (each ad, font and picture) waited on a round
	// trip through this process.
	const filter = { urls: ['https://' + APP_HOST + '/*', 'https://*.' + APP_HOST + '/*'] };
	session.defaultSession.webRequest.onHeadersReceived(filter, (details, callback) => {
		reportMissingCsp(details);
		trackSignIn(details);
		callback({ responseHeaders: details.responseHeaders });
	});
}

let offlineRegistered = false;

function trackSignIn(details) {
	if (!offlineStore) return;
	const signal = offline.signInSignal(details);
	if (signal === 'in') {
		if (offlineStore.signedIn()) buildAppMenu();
	} else if (signal === 'out') {
		const wasSignedIn = offlineStore.get().signedIn;
		offlineStore.signedOut();
		offlineRegistered = false;
		if (wasSignedIn) {
			forgetOfflineGames();
			buildAppMenu();
		}
	}
}

function forgetOfflineGames() {
	session.defaultSession.clearStorageData({
		origin: offline.SITE,
		storages: ['serviceworkers', 'cachestorage']
	}).catch((err) => console.warn('[offline] could not remove the stored games: ' + err.message));
}

function enableOfflineGames(contents) {
	if (offlineRegistered || !offlineStore || !offlineStore.get().signedIn) return;
	offlineRegistered = true;

	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error('timed out')), 2 * 60 * 1000);
	});
	Promise.race([contents.executeJavaScript(offline.registerScript()), timeout])
		.then((scopes) => {
			if (!Array.isArray(scopes)) {
				offlineRegistered = false;
			} else if (offlineStore.get().signedIn) {
				offlineStore.ready(scopes);
				// Some game is not stored (a flaky connection, or the site's
				// worker not knowing it yet): try again on the next dashboard.
				if (scopes.length < offline.SCOPES.length) offlineRegistered = false;
			} else {
				forgetOfflineGames();
			}
		})
		.catch((err) => {
			offlineRegistered = false;
			console.warn('[offline] the games could not be stored for offline play: ' + err.message);
		})
		.finally(() => clearTimeout(timer));
}
async function clearAppCache() {
	const ses = session.defaultSession;
	const results = await Promise.allSettled([
		ses.clearCache(),
		ses.clearCodeCaches({}),
		ses.clearStorageData({ storages: ['shadercache'] }),
		ses.clearHostResolverCache()
	]);
	const failed = results.filter((r) => r.status === 'rejected');
	for (const r of failed) {
		console.warn('[cache] could not clear part of the cache: ' + (r.reason && r.reason.message));
	}
	return { ok: failed.length === 0 };
}

// How much clearAppCache() would free, in bytes: the HTTP cache plus the
// code and shader caches kept beside it. Cookies, saves and the offline
// games' storage are not counted, as they are not cleared.
async function appCacheSize() {
	const ses = session.defaultSession;
	const base = ses.getStoragePath() || app.getPath('userData');
	const sizes = await Promise.all([
		ses.getCacheSize().catch(() => 0),
		dirSize(path.join(base, 'Code Cache')),
		dirSize(path.join(base, 'GPUCache')),
		dirSize(path.join(base, 'DawnGraphiteCache')),
		dirSize(path.join(base, 'DawnWebGPUCache'))
	]);
	return { bytes: sizes.reduce((a, b) => a + b, 0) };
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

function showSplash(failedUrl) {
	if (!win || win.isDestroyed()) return;
	const query = {};
	if (failedUrl) {
		query.failed = '1';
		const game = offline.gameOf(failedUrl);
		if (game) query.game = game;
	}
	win.loadFile('download.html', { query }).catch(() => {});
}

async function pingSite() {
	const url = offline.SITE + '/v2/ping.php?usingnativeapp=1&firsthello=1&_=' + Date.now();
	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(), 8000);
	try {
		const res = await net.fetch(url, { cache: 'no-store', signal: abort.signal });
		const body = res.ok ? (await res.text()).trim().slice(0, 64) : '';
		return { ok: res.ok, status: res.status, pong: body === 'Pong!' };
	} catch (err) {
		return { ok: false, status: 0, pong: false };
	} finally {
		clearTimeout(timer);
	}
}

const AUTH_PRELOAD = path.join(__dirname, 'Content/JS/auth-preload.js');
const authContents = new WeakSet();
let openingAuthWindow = false;

function authWindowOptions() {
	return {
		width: 520,
		height: 720,
		minWidth: 400,
		minHeight: 480,
		title: 'Sign in',
		backgroundColor: '#ffffff',
		// decorateAuthWindow() shows it.
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

function openInMainWindow(url) {
	if (!win || win.isDestroyed()) return;
	win.loadURL(url).catch(() => {});
	if (win.isMinimized()) win.restore();
	win.focus();
}

function handOff(popupContents, url) {
	openInMainWindow(url);
	closePopup(popupContents);
}

function closePopup(popupContents) {
	const popup = BrowserWindow.fromWebContents(popupContents);
	// Not from inside the navigation event that is being cancelled.
	setImmediate(() => { if (popup && !popup.isDestroyed()) popup.close(); });
}

// Every sign-in popup, once the sign-in has finished in the browser instead.
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

function openAuthWindow(url) {
	if (authWindow && !authWindow.isDestroyed()) {
		authWindow.loadURL(url);
		authWindow.focus();
		return;
	}
	const options = authWindowOptions();
	if (win && !win.isDestroyed()) options.parent = win;
	authWindow = new BrowserWindow(options);
	decorateAuthWindow(authWindow);
	authWindow.on('closed', () => { authWindow = null; });
	authWindow.loadURL(url);
}

const WINDOW_CHROME_CSS = [
	'a, button, input, select, textarea, label, summary, i, svg,',
	'[onclick], [role="button"], [data-app-window], .btn {',
	'  -webkit-app-region: no-drag !important;',
	'}'
].join('\n');

app.on('web-contents-created', (_event, contents) => {
	if (openingAuthWindow) {
		openingAuthWindow = false;
		authContents.add(contents);
	}

	contents.on('will-attach-webview', (event) => event.preventDefault());

	const guard = (event, url, isRedirect, isMainFrame) => {
		if (isMainFrame && isBrowserSignInUrl(url)) {
			event.preventDefault();
			startBrowserSignIn(url);
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

		if (isAppUrl(url)) return;
		event.preventDefault();

		if (!isMainFrame || !win || win.isDestroyed() || contents !== win.webContents) return;

		if (isRedirect && isAuthUrl(url)) {
			openAuthWindow(url);
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
			startBrowserSignIn(url);
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
			openInMainWindow(url);
		} else if (/^https:\/\//i.test(url) && !isAppUrl(url)) {
			shell.openExternal(url);
		}
		return { action: 'deny' };
	});
	contents.on('did-create-window', (child) => decorateAuthWindow(child));
});

function useBrowserUserAgentForAuth() {
	const clean = browserUserAgent(app.userAgentFallback, app.getName());

	// The sign-in hosts only, as above.
	const filter = { urls: [...AUTH_HOSTS].map((host) => 'https://' + host + '/*') };
	session.defaultSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
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

const WINDOW_BACKGROUND = '#1e1e91';

const WINDOW_STATE_FILE = () => path.join(app.getPath('userData'), 'window-state.json');

// startUrl: a page on the site to open instead of the splash.
function createDefaultWindow(startUrl) {
	// Where and how big it was last time, if that still fits a display that
	// is plugged in; and never wider or taller than the display, least of all
	// its minimum size (975 wide is more than a 1366x768 laptop at 150% has).
	const placed = windowState.place(
		windowState.load(WINDOW_STATE_FILE()),
		screen.getAllDisplays().map((d) => d.workArea),
		screen.getPrimaryDisplay().workArea,
		{ width: 1100, height: 700, minWidth: 975, minHeight: 480 });

	win = new BrowserWindow({
    width: placed.width,
    height: placed.height,
	x: placed.x,
	y: placed.y,
	frame: isMac,
	titleBarStyle: isMac ? 'hidden' : 'default',
	minWidth: placed.minWidth,
	minHeight: placed.minHeight,
	movable: true,
	minimizable: true,
	resizable: true,
	title: 'Empanadas.io',
	backgroundColor: WINDOW_BACKGROUND,
	transparent: false,
	webPreferences: {
	  preload: path.join(__dirname, 'Content/JS/preload.js'),
      webSecurity: true,
	  contextIsolation: true,
      nodeIntegration: false,
	  disableBlinkFeatures: "Auxclick",
	  sandbox: true,
	  webviewTag: false,
	  allowRunningInsecureContent: false,
	  experimentalFeatures: false,
	  devTools: false,
	  zoomFactor: 1.05
	},
	icon: path.join(__dirname, 'icon.png')
  })
  if (isMac) {
	const hideTrafficLights = () => {
		if (win && !win.isDestroyed()) win.setWindowButtonVisibility(false);
	};
	hideTrafficLights();
	win.on('leave-full-screen', hideTrafficLights);
  }
  
  if (placed.maximized) win.maximize();

  const self = win;
  self.on('close', (event) => {
	const w = self;
	if (w.isDestroyed()) return;
	// Clicked again while the game is being handed to the tray.
	if (handingOff) {
		event.preventDefault();
		return;
	}
	windowState.save(WINDOW_STATE_FILE(), Object.assign({}, w.getNormalBounds(), {
		maximized: w.isMaximized()
	}));
	if (shouldKeepSpinning(w)) {
		event.preventDefault();
		handOffToBackground(w);
	}
  });

  win.on('closed', () => {
    win = null;
  })

  watchForCrashes(win);

  win.webContents.on('dom-ready', () => {
	if (!isAppUrl(win.webContents.getURL())) return;
	win.webContents.insertCSS(WINDOW_CHROME_CSS, { cssOrigin: 'user' }).catch(() => {});
  })

  const sendWindowState = () => {
	if (!win || win.isDestroyed()) return;
	win.webContents.send('window-state', { maximized: win.isMaximized() });
  };
  win.on('maximize', sendWindowState);
  win.on('unmaximize', sendWindowState);
  win.webContents.on('did-navigate', () => {
	if (win && !win.isDestroyed()) win.setBackgroundColor(WINDOW_BACKGROUND);
  });

  win.webContents.on('did-finish-load', () => {
	const url = win.webContents.getURL();
	if (pendingDeepLink && isAppUrl(url)) {
		win.webContents.send('deep-link', pendingDeepLink);
		pendingDeepLink = null;
	}
	if (offline.isDashboardUrl(url)) enableOfflineGames(win.webContents);
  })

  win.webContents.on('did-fail-load', (_event, errorCode, _description, url, isMainFrame) => {
	if (!isMainFrame || errorCode === -3 || !isAppUrl(url)) return;
	showSplash(url);
  })

  if (startUrl && isAppUrl(startUrl)) {
	// A failure is handled by did-fail-load, which brings the splash back.
	win.loadURL(startUrl).catch(() => {});
  } else {
	win.loadFile('download.html')
  }
  //win.webContents.openDevTools();
  return win;
}

// The window has no frame and draws its own buttons in the page, so a page
// that has died or hung leaves nothing to close it with. A dead one goes back
// to the splash, which has the window bar and tries the site again; a hung
// one asks.
function watchForCrashes(w) {
	let lastCrash = 0;
	let asking = false;

	w.webContents.on('render-process-gone', (_event, details) => {
		if (!details || details.reason === 'clean-exit' || w.isDestroyed()) return;
		console.warn('[window] the page went away: ' + details.reason);
		// Twice in a few seconds is the splash itself failing: stop, rather
		// than go round and round.
		const now = Date.now();
		const again = now - lastCrash < 10 * 1000;
		lastCrash = now;
		if (again) {
			w.close();
			return;
		}
		w.loadFile('download.html').catch(() => {});
	});

	w.on('unresponsive', async () => {
		if (asking || w.isDestroyed()) return;
		asking = true;
		try {
			const { response } = await dialog.showMessageBox(w, {
				type: 'warning',
				title: 'Empanadas.io',
				message: 'Empanadas.io is not responding.',
				detail: 'You can wait for it, or start it again.',
				buttons: ['Wait', 'Restart', 'Close'],
				defaultId: 0,
				cancelId: 0
			});
			if (w.isDestroyed()) return;
			if (response === 1) {
				// render-process-gone, above, takes it from there.
				w.webContents.forcefullyCrashRenderer();
			} else if (response === 2) {
				w.destroy();
			}
		} finally {
			asking = false;
		}
	});
}

// --- Keep Spinning When Closed ------------------------------------------
// lib/background.js has the rules; this is the Electron half: the hand-over
// from the page, the save requests, the tray, and the process priority.

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
	return backgroundStatus();
}

function shouldKeepSpinning(w) {
	return backgroundStatus().enabled && !quitting && !bg && !closingForReal.has(w) &&
		offline.gameOf(w.webContents.getURL()) === 'spin';
}

function withTimeout(promise, ms) {
	let timer;
	return Promise.race([
		promise,
		new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); })
	]).finally(() => clearTimeout(timer));
}

// window.spinBackgroundHandoff() and spinBackgroundResume() are the Spin
// Game's (_spin.js in the Empanadas-io repo). A game from before them answers
// null, and closes as it always has.
const HANDOFF_SCRIPT = "typeof window.spinBackgroundHandoff === 'function' ? window.spinBackgroundHandoff() : null";
const RESUME_SCRIPT = "typeof window.spinBackgroundResume === 'function' ? window.spinBackgroundResume() : null";

// One save to updatedata.php, with the window's cookies and user agent (the
// site ties a session to the browser that signed in). Resolves { status, body }
// or null for no answer.
function postSave(fields, userAgent) {
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
				url: offline.SITE + '/v2/updatedata.php',
				session: session.defaultSession,
				useSessionCookies: true,
				origin: offline.SITE,
				redirect: 'error',
				cache: 'no-store'
			});
			req.setHeader('Content-Type', 'application/x-www-form-urlencoded');
			if (userAgent) req.setHeader('User-Agent', userAgent);
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

// Closing the Spin Game with the setting on. The page hands over its game and
// stops; that save is posted, and only once it has landed does the window go
// and the tray take over. Anything else (an older game, nothing for Auto
// Spinners to do, offline, a refused save) closes the window as before.
async function handOffToBackground(w) {
	handingOff = true;
	let started = false;
	try {
		const handoff = background.cleanHandoff(
			await withTimeout(w.webContents.executeJavaScript(HANDOFF_SCRIPT, true).catch(() => null), 3000));
		if (handoff && net.isOnline() && !w.isDestroyed()) {
			const userAgent = w.webContents.getUserAgent();
			const first = background.judgeReply(await postSave(background.saveFields(handoff.save), userAgent));
			if (first.action === 'ok' && !w.isDestroyed() && !quitting) {
				startBackground(handoff, userAgent);
				started = true;
				w.destroy();
			} else {
				console.warn('[background] the game was not handed over: ' + (first.why || first.action));
			}
		}
		if (!started && handoff && !w.isDestroyed()) {
			// The page saves what it has as it closes, as it always has.
			await withTimeout(w.webContents.executeJavaScript(RESUME_SCRIPT, true).catch(() => null), 1000);
		}
	} catch (err) {
		console.warn('[background] ' + err.message);
	} finally {
		handingOff = false;
	}
	if (!started && !w.isDestroyed()) {
		closingForReal.add(w);
		w.close();
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

// The app's own processes (this one, the GPU and network helpers) at the
// lowest priority while in the tray, and back to normal after. Returns false
// when one could not be put back: a Mac only lets a process be made less
// important, never more, without admin rights.
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
			// A process that has just ended does not count.
			if (err && err.code !== 'ESRCH') ok = false;
		}
	}
	return ok;
}

function startBackground(handoff, userAgent) {
	bg = { tray: new Tray(trayIcon()), runner: null, leaving: false };
	if (!isMac) {
		// Windows: a click on the tray icon opens the game; right-click is the menu.
		bg.tray.on('click', () => leaveBackground({ open: true }));
	}
	bg.runner = background.createRunner(handoff, {
		post: (fields) => postSave(fields, userAgent),
		wall: () => Date.now(),
		mono: () => performance.now(),
		load: background.createLoadMeter(process.platform),
		online: () => net.isOnline(),
		onChange: drawTray,
		onStop: (why) => {
			if (why === 'won') notifyPrestige();
		},
		onOverload: () => {
			console.warn('[background] the computer has been busy too long: saving and quitting');
			leaveBackground({ quit: true });
		}
	});
	// Nothing else runs while in the tray: no update checks (a download is
	// the heaviest thing the app does), and the lowest priority there is.
	updater.stop();
	setAppPriority(os.constants.priority.PRIORITY_LOW);
	if (isMac && app.dock) app.dock.hide();
}

function notifyPrestige() {
	try {
		if (!Notification.isSupported()) return;
		const note = new Notification({
			title: 'Ready to Prestige!',
			body: 'Your Auto Spinners reached 100,000 Spins. Open the Spin Game to Prestige.'
		});
		note.on('click', () => leaveBackground({ open: true }));
		note.show();
	} catch (err) {
		// The tray says so too.
	}
}

// Out of the tray: { open: true } brings the Spin Game back, { quit: true }
// quits. Either way what has built up since the last save is saved first, so
// the game opens to the spins the tray showed.
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
	createDefaultWindow(offline.gameUrl('spin'));
}

// The main window, or null once it is closed (macOS keeps the app running).
function mainWindow() {
	return win && !win.isDestroyed() ? win : null;
}

function goToDashboard() {
	const w = mainWindow();
	if (w) w.loadURL(offline.SITE + '/v2/dashboard').catch(() => {});
}

function openGame(name) {
	const w = mainWindow();
	const status = offlineStore ? offlineStore.get() : null;
	if (!w || !status || !status.signedIn || !offline.gameUrl(name)) return;
	const fromSplash = isSplashUrl(w.webContents.getURL());
	const url = fromSplash && offline.playableOffline(status, name) ? offline.offlinePlayUrl(name) : offline.gameUrl(name);
	w.loadURL(url).catch(() => {});
}

function registerIpcHandlers() {
	const target = mainWindow;

	const handle = (channel, fn) => {
		ipcMain.handle(channel, (event, ...args) => {
			if (!isTrustedSender(event)) {
				console.warn('[ipc] refused ' + channel + ' from ' +
					(event.senderFrame ? event.senderFrame.url : 'unknown'));
				return null;
			}
			return fn(...args);
		});
	};

	handle('window-minimize', () => { const w = target(); if (w) w.minimize(); });
	handle('window-maximize', () => {
		const w = target();
		if (!w) return false;
		if (w.isMaximized()) w.unmaximize();
		else w.maximize();
		return w.isMaximized();
	});
	handle('window-close', () => { const w = target(); if (w) w.close(); });
	handle('window-is-maximized', () => { const w = target(); return !!(w && w.isMaximized()); });

	handle('update-check', () => updater.checkFromRenderer());
	handle('update-state', () => updater.getState());

	handle('app-ping', () => pingSite());
	handle('app-clear-cache', () => clearAppCache());
	handle('app-cache-size', () => appCacheSize());
	handle('offline-status', () => offlineStore ? offlineStore.get() : { signedIn: false, ready: false, available: false, games: [] });

	handle('offline-play', (name) => {
		const url = offline.gameUrl(name);
		const w = target();
		// Only a game whose worker is installed: one added by an app update
		// is not stored until the dashboard next loads online.
		if (!url || !w || !offlineStore || !offline.playableOffline(offlineStore.get(), name)) return false;
		// A failure is handled by did-fail-load, which brings the splash back.
		w.loadURL(offline.offlinePlayUrl(name)).catch(() => {});
		return true;
	});
	handle('app-home', () => goToDashboard());

	handle('background-status', () => backgroundStatus());
	handle('background-set', (value) => setBackgroundEnabled(value === true));
}

function buildAppMenu() {
	if (!isMac) return;

	const signedIn = !!(offlineStore && offlineStore.get().signedIn);
	const history = () => {
		const w = mainWindow();
		return w ? w.webContents.navigationHistory : null;
	};

	Menu.setApplicationMenu(Menu.buildFromTemplate([
		{
			label: app.getName(),
			submenu: [
				{ role: 'about' },
				{ type: 'separator' },
				{
					label: 'Check for Updates…',
					click: () => updater.checkFromRenderer()
				},
				{ type: 'separator' },
				{
					// The same setting as the switch in the Spin Game's settings.
					label: 'Keep Spinning When Closed',
					type: 'checkbox',
					checked: backgroundStatus().enabled,
					enabled: backgroundAvailable(),
					click: (item) => setBackgroundEnabled(item.checked)
				},
				{ type: 'separator' },
				{ role: 'services' },
				{ type: 'separator' },
				{ role: 'hide' },
				{ role: 'hideOthers' },
				{ role: 'unhide' },
				{ type: 'separator' },
				{ role: 'quit' }
			]
		},
		{
			label: 'Edit',
			submenu: [
				{ role: 'undo' },
				{ role: 'redo' },
				{ type: 'separator' },
				{ role: 'cut' },
				{ role: 'copy' },
				{ role: 'paste' },
				{ role: 'selectAll' }
			]
		},
		{
			label: 'View',
			// No togglefullscreen item: macOS adds its own Enter Full Screen
			// here. macOS also gives the role item a hidden duplicate, which
			// Electron 41+ removes only while it is hidden, but Electron's
			// menu refresh un-hides it first, so it showed twice.
			submenu: [
				{ role: 'reload' }
			]
		},
		{
			label: 'Go',
			submenu: [
				{
					label: 'Back',
					accelerator: 'Cmd+[',
					click: () => { const h = history(); if (h && h.canGoBack()) h.goBack(); }
				},
				{
					label: 'Forward',
					accelerator: 'Cmd+]',
					click: () => { const h = history(); if (h && h.canGoForward()) h.goForward(); }
				},
				{ type: 'separator' },
				{
					label: 'Dashboard',
					accelerator: 'Cmd+Shift+D',
					enabled: signedIn,
					click: () => goToDashboard()
				},
				{ type: 'separator' },
				{
					label: 'Launch Flappy',
					accelerator: 'Cmd+1',
					enabled: signedIn,
					click: () => openGame('flappy')
				},
				{
					label: 'Launch Spin',
					accelerator: 'Cmd+2',
					enabled: signedIn,
					click: () => openGame('spin')
				},
				{
					label: 'Launch Tower',
					accelerator: 'Cmd+3',
					enabled: signedIn,
					click: () => openGame('tower')
				}
			]
		},
		{
			label: 'Window',
			submenu: [
				{ role: 'minimize' },
				{ role: 'zoom' },
				// Cmd+W: the traffic lights are hidden, so without this the
				// only way to close the window was the page's own button.
				{ role: 'close' },
				{ type: 'separator' },
				{ role: 'front' }
			]
		}
	]));
}

app.on('ready', function()  {
  if (!gotTheLock) return;
  offlineStore = offline.createStore(path.join(app.getPath('userData'), 'offline.json'));
  backgroundSettings = background.createSettings(path.join(app.getPath('userData'), 'background.json'));
  lockDownPermissions();
  useBrowserUserAgentForAuth();
  watchResponses();
  registerIpcHandlers();
  buildAppMenu();
  // Back from the tray on a Mac, which starts the app again (leaveBackground()).
  createDefaultWindow(process.argv.includes(OPEN_SPIN_ARG) ? offline.gameUrl('spin') : undefined);
  updater.setWindowProvider(() => win);
  updater.start();
  // Asleep is not playing: no spins for the night a laptop spent shut.
  powerMonitor.on('suspend', () => { if (bg) bg.runner.pause(); });
  powerMonitor.on('resume', () => { if (bg) bg.runner.resume(); });
});

app.on('activate', () => {
  if (!gotTheLock || !app.isReady()) return;
  if (bg) {
	  leaveBackground({ open: true });
	  return;
  }
  if (!win || win.isDestroyed()) {
	  createDefaultWindow();
  } else {
	  win.show();
  }
});

// Quitting from the tray, or Cmd+Q with the game in the menu bar: what the
// Auto Spinners made since the last save goes first (leaveBackground()).
app.on('before-quit', (event) => {
  if (bg && !bg.leaving) {
	  event.preventDefault();
	  leaveBackground({ quit: true });
	  return;
  }
  quitting = true;
});

app.on('window-all-closed', () => {
  // Not while the game is in the tray, or on its way there.
  if (!isMac && !bg && !handingOff) {
	  app.quit();
  }
});
