const {app, BrowserWindow, ipcMain, Menu, net, shell, session} = require('electron');
const path = require('path');
const updater = require('./updater');
const isMac = process.platform === 'darwin';

const {
	isAppUrl, isAuthUrl, isSsoUrl, isPopupUrl, isHandoffUrl,
	isBrowserSignInUrl, isAuthDeepLink, authRedeemUrl, browserUserAgent
} = require('./lib/urls');
const offline = require('./lib/offline');

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

let win;

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

	if (win && !win.isDestroyed() && isAppUrl(win.webContents.getURL())) {
		if (win.isMinimized()) win.restore();
		win.focus();
		win.webContents.send('deep-link', url);
	} else {
		pendingDeepLink = url;
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
	session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
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
		.then((ok) => {
			if (ok !== true) {
				offlineRegistered = false;
			} else if (offlineStore.get().signedIn) {
				offlineStore.ready();
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

	session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
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

function createDefaultWindow() {
	win = new BrowserWindow({
    width: 1100,
    height: 700,
	frame: isMac,
	titleBarStyle: isMac ? 'hidden' : 'default',
	minWidth: 975,
	minHeight: 480,
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
  
  win.on('closed', () => {
    win = null;
  })

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

  win.loadFile('download.html')
  //win.webContents.openDevTools();
  return win;
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
			submenu: [
				{ role: 'reload' },
				{ type: 'separator' },
				{ role: 'togglefullscreen' }
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
				{ type: 'separator' },
				{ role: 'front' }
			]
		}
	]));
}

app.on('ready', function()  {
  if (!gotTheLock) return;
  offlineStore = offline.createStore(path.join(app.getPath('userData'), 'offline.json'));
  lockDownPermissions();
  useBrowserUserAgentForAuth();
  watchResponses();
  registerIpcHandlers();
  buildAppMenu();
  createDefaultWindow();
  updater.setWindowProvider(() => win);
  updater.start();
});

app.on('activate', () => {
  if (!gotTheLock || !app.isReady()) return;
  if (!win || win.isDestroyed()) {
	  createDefaultWindow();
  } else {
	  win.show();
  }
});

app.on('window-all-closed', () => {
  if (!isMac) {
	  app.quit();
  }
});