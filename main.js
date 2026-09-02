const {app, BrowserWindow, ipcMain, Menu, shell, session} = require('electron');
const path = require('path');
const updater = require('./updater');

const isMac = process.platform === 'darwin';

// isAppUrl / isAuthUrl decide what counts as "our site" and what counts as a
// sign-in provider. They live in lib/urls.js so they can be tested without a
// running Electron; see the comments there for why the host is parsed rather
// than prefix-matched.
const { isAppUrl, isAuthUrl, browserUserAgent } = require('./lib/urls');

// download.html is the only local page, and it is the only sender allowed to
// drive the window chrome besides the site itself.
const SPLASH_URL = require('url').pathToFileURL(path.join(__dirname, 'download.html')).href;

function isTrustedSender(event) {
	let url = '';
	try {
		// senderFrame throws if the frame was disposed between send and handle.
		url = (event.senderFrame && event.senderFrame.url) || '';
	} catch (err) {
		return false;
	}
	return isAppUrl(url) || url === SPLASH_URL;
}

//const Store = require('electron-store');

//const store = new Store();

//store.set('Settings.Theme', 0);
//console.log(store.get('Settings.Theme'));

//store.set('Settings.Volume', 100);
//console.log(store.get('Settings.Volume'));

// NOTE: this used to read appendSwitch('no-proxy-server') but the string held a
// zero-width space (U+200B) after 'server', so Chromium never recognised the
// switch and the app has always honoured the system proxy. Left off
// deliberately - turning it on now would cut off anyone behind a corporate
// proxy, including the updater's calls to api.github.com.
// app.commandLine.appendSwitch('no-proxy-server')
app.commandLine.appendSwitch('force_high_performance_gpu')

let win;

app.enableSandbox();

//console.log(process.argv);

//app.setUserTasks([
//  {
//    program: process.execPath,
//    arguments: '--new-window',
//    iconPath: process.execPath,
//    iconIndex: 0,
//    title: 'New Window',
//    description: 'Create a new window'
//  }
//])

if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('empanadas-io', process.execPath, [path.resolve(process.argv[1])])
  }
} else {
  app.setAsDefaultProtocolClient('empanadas-io')
}

// A deep link can arrive before the window exists, so hold onto the last one
// and hand it over once there's a renderer to hand it to.
let pendingDeepLink = null;

function handleDeepLink(url) {
	if (!url || !url.startsWith('empanadas-io:')) return;
	// Anything on the machine can invoke the protocol handler, so treat the URL
	// as untrusted input: it has to parse, and it does not get to be unbounded
	// before it reaches the page.
	if (url.length > 2048) return;
	try {
		if (new URL(url).protocol !== 'empanadas-io:') return;
	} catch (err) {
		return;
	}
	if (win && !win.isDestroyed()) {
		if (win.isMinimized()) win.restore();
		win.focus();
		win.webContents.send('deep-link', url);
	} else {
		pendingDeepLink = url;
	}
}

const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
	app.quit()
	} else {
	  app.on('second-instance', (event, commandLine, workingDirectory) => {
		// Someone tried to run a second instance, we should focus our window.
		if (win) {
		  if (win.isMinimized()) win.restore()
		  win.focus()
		}
		// Windows and Linux deliver the protocol URL as an argv entry.
		handleDeepLink(commandLine.find((arg) => arg.startsWith('empanadas-io:')));
	})
}

// macOS never puts the URL in argv - it arrives here instead, and can fire
// before 'ready'.
app.on('open-url', (event, url) => {
	event.preventDefault();
	handleDeepLink(url);
});

// Deny anything the site does not need. Without a handler Electron prompts (or
// on some permissions silently grants), and the window loads a remote page.
function lockDownPermissions() {
	// Fullscreen and pointer lock are the only ones a game page has a real use
	// for; everything else - camera, microphone, geolocation, USB, HID, MIDI,
	// notifications, arbitrary clipboard reads - is refused outright.
	const ALLOWED = new Set(['fullscreen', 'pointerLock']);

	const ses = session.defaultSession;

	ses.setPermissionRequestHandler((contents, permission, callback, details) => {
		const origin = (details && details.requestingUrl) || contents.getURL();
		callback(ALLOWED.has(permission) && isAppUrl(origin));
	});

	ses.setPermissionCheckHandler((contents, permission, origin) =>
		ALLOWED.has(permission) && isAppUrl(origin));

	// Chrome's device-picker APIs bypass the permission handler above.
	ses.setDevicePermissionHandler(() => false);
	if (ses.setBluetoothPairingHandler) ses.setBluetoothPairingHandler(() => {});
}

// Everything above hardens the shell. Once the window is on empanadas.io, the
// page's own headers are what stand between an injected script and the app, and
// those are served by the site, not set here.
//
// This only reports. Injecting a policy from the app would be enforcing a guess
// about what the site needs, and getting it wrong breaks the game with no error
// the user can act on - the right fix is the header, on the server. The warning
// makes its absence visible during development instead of never.
let cspReported = false;

function watchSiteCsp() {
	session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
		const isPageLoad = details.resourceType === 'mainFrame' && isAppUrl(details.url);

		if (isPageLoad && !cspReported) {
			const headers = details.responseHeaders || {};
			const has = Object.keys(headers).some((name) =>
				name.toLowerCase() === 'content-security-policy');
			if (!has) {
				cspReported = true;
				console.warn(
					'[security] ' + details.url + ' served no Content-Security-Policy ' +
					'header. See "Site headers" in the README for the recommended set.');
			}
		}

		callback({ responseHeaders: details.responseHeaders });
	});
}

// Sign-in popups. "Log in with Google/GitHub/Discord" is a window.open() to the
// provider, and denying it is exactly what the page sees as a blocked popup:
// window.open() returns null and the site reports that the popup was blocked.
// So the popup is allowed - but only to an auth host, and only as a window with
// none of this app's privileges.
const AUTH_PRELOAD = path.join(__dirname, 'Content/JS/auth-preload.js');

// The contents that belong to a sign-in popup. A WeakSet, so a closed popup is
// not kept alive by being remembered.
const authContents = new WeakSet();

// setWindowOpenHandler has no handle on the contents it is about to create, and
// 'web-contents-created' cannot tell why it fired. Electron creates the child
// synchronously between the two, so the handler flags what is coming and the
// next created contents claims the flag. 'did-create-window' marks it a second
// time in case that ever stops being synchronous.
let openingAuthWindow = false;

function authWindowOptions() {
	return {
		width: 520,
		height: 720,
		minWidth: 400,
		minHeight: 480,
		title: 'Sign in',
		backgroundColor: '#ffffff',
		autoHideMenuBar: true,
		minimizable: false,
		maximizable: false,
		fullscreenable: false,
		// A child window inherits the opener's webPreferences, so every one of
		// these has to be restated: inheriting would give accounts.google.com
		// the window controls and the updater bridge.
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

// Applies to every WebContents, including any the site manages to spawn.
app.on('web-contents-created', (_event, contents) => {
	if (openingAuthWindow) {
		openingAuthWindow = false;
		authContents.add(contents);
	}

	// The app embeds nothing, so a <webview> could only have come from the
	// remote page.
	contents.on('will-attach-webview', (event) => event.preventDefault());

	// will-navigate does not fire for server-side redirects, so a 302 off
	// empanadas.io would otherwise walk straight past the check below.
	const guard = (event, url) => {
		if (isAppUrl(url)) return;
		// A sign-in flow is several navigations - consent, 2FA, the redirect
		// back - so the popup may move around the provider's own hosts. Only
		// the popup: the main window still goes nowhere but empanadas.io.
		if (isAuthUrl(url) && authContents.has(contents)) return;
		event.preventDefault();
	};
	contents.on('will-navigate', guard);
	contents.on('will-redirect', guard);

	// Anything that is not a sign-in page opens in the user's own browser, and
	// never as a second BrowserWindow here.
	contents.setWindowOpenHandler(({ url }) => {
		// Only the site itself gets to raise a sign-in window, and a popup
		// cannot raise another one.
		if (isAuthUrl(url) && isAppUrl(contents.getURL())) {
			openingAuthWindow = true;
			// If the window never gets created, the flag must not be left
			// lying around for some unrelated WebContents to pick up.
			setImmediate(() => { openingAuthWindow = false; });
			return {
				action: 'allow',
				// The popup closes with the window that opened it rather than
				// outliving it as an orphan the user cannot get back to.
				outlivesOpener: false,
				overrideBrowserWindowOptions: authWindowOptions()
			};
		}
		if (/^https:\/\//i.test(url) && !isAppUrl(url)) shell.openExternal(url);
		return { action: 'deny' };
	});

	contents.on('did-create-window', (child, details) => {
		if (!isAuthUrl(details.url)) return;
		authContents.add(child.webContents);
		if (child.setMenu) child.setMenu(null);
		// The provider decides the title; the window says what it is for.
		child.setTitle('Sign in');
		child.on('page-title-updated', (event) => event.preventDefault());
	});
});

// Google rejects OAuth from a user agent it recognises as an embedded browser,
// which is what the default string ("... Empanadas.io/1.11.0 ... Electron/44
// ...") advertises. Present a plain Chrome user agent to the auth hosts only.
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

function createDefaultWindow() {
	win = new BrowserWindow({
    width: 1100,
    height: 700,
	// A frameless window on macOS would drop the traffic lights and leave no
	// way to move, zoom or close the window, since the in-page titlebar is
	// served from empanadas.io. 'hiddenInset' keeps them over the page.
	frame: isMac,
	titleBarStyle: isMac ? 'hiddenInset' : 'default',
	trafficLightPosition: isMac ? { x: 14, y: 14 } : undefined,
	minWidth: 975,
	minHeight: 480,
	movable: true,
	minimizable: true,
	// 'resizeable' is not an option name - the window was only resizable
	// because true is the default.
	resizable: true,
	title: 'Empanadas.io',
	backgroundColor: '#1e1e91',
	transparent: false,
	webPreferences: {
	  preload: path.join(__dirname, 'Content/JS/preload.js'),
      webSecurity: true,
	  contextIsolation: true,
      nodeIntegration: false,
	  disableBlinkFeatures: "Auxclick",
	  sandbox: true,
	  webviewTag: false,
	  // The site is the only thing loaded here; there is nothing for it to
	  // reach on the local machine.
	  allowRunningInsecureContent: false,
	  experimentalFeatures: false,
	  devTools: false
	},
	zoomFactor: 1.1,
	icon: 'icon.png'
  })
  // don't ovverride win.webContents.setFrameRate(144);
  win.on('closed', () => {
    win = null;
  })

  win.webContents.on('did-finish-load', () => {
	if (pendingDeepLink) {
		win.webContents.send('deep-link', pendingDeepLink);
		pendingDeepLink = null;
	}
  })
  
	//const electronDl = require('electron-dl');
	//electronDl();
	
// {download} = require('electron-dl');

//ipcMain.on('download-button', async (event, {url}) => {
 	//const win = BrowserWindow.getFocusedWindow();
 	//console.log(await download(win, url));
//});

  // Navigation is filtered in the 'web-contents-created' handler above, which
  // covers redirects and any contents the page spawns, not just this window.
  win.loadFile('download.html')
  //win.webContents.openDevTools();
  return win;
}

// Registered once for the life of the app, not per window: on macOS the window
// is recreated when the dock icon is clicked, and ipcMain.handle throws if the
// same channel is registered twice.
function registerIpcHandlers() {
	const target = () => win && !win.isDestroyed() ? win : null;

	// The preload is attached to whatever the window navigates to, so every
	// handler checks who is actually calling rather than trusting that it can
	// only be our own page.
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

	handle('update-check', () => updater.checkFromRenderer());
	handle('update-state', () => updater.getState());
}

// Without an application menu macOS has no Cmd+Q, Cmd+W, or - the one that
// actually bites - Cmd+C/Cmd+V, since those are menu-driven rather than
// handled by the web contents. Windows and Linux keep their existing
// (menu-less, frameless) look.
function buildAppMenu() {
	if (!isMac) return;

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
  lockDownPermissions();
  useBrowserUserAgentForAuth();
  watchSiteCsp();
  registerIpcHandlers();
  buildAppMenu();
  createDefaultWindow();
  updater.start();
});

app.on('activate', () => {
  // Clicking the dock icon with no windows open must reopen one, otherwise
  // 'window-all-closed' below leaves the app running with nothing to show.
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