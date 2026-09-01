const {app, BrowserWindow, ipcMain, Menu} = require('electron');
const path = require('path');
const updater = require('./updater');

const isMac = process.platform === 'darwin';

//const Store = require('electron-store');

//const store = new Store();

//store.set('Settings.Theme', 0);
//console.log(store.get('Settings.Theme'));

//store.set('Settings.Volume', 100);
//console.log(store.get('Settings.Volume'));

app.commandLine.appendSwitch('no-proxy-server​')
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

process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = false;

function createDefaultWindow() {
	win = new BrowserWindow({
    width: 1100,
    height: 700,
	webviewTag: true,
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
	resizeable: true,
	title: 'Empanadas.io',
	backgroundColor: '#1e1e91',
	transparent: false,
	webPreferences: {
	  preload: path.join(__dirname, 'Content/JS/preload.js'),
      webSecurity: true,
	  contextIsolation: true,
      nodeIntegration: false,
	  disableBlinkFeatures: "Auxclick",
	  "sandbox": true,
	  devTools: false
	},
	zoomFactor: 1.1,
	javascript: true,
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

  win.webContents.on('will-navigate', (event, newURL) => {
	  //log.info("Going from: "+  win.webContents.getURL());
	  //log.info("Redirecting To: " + newURL);
	if (!newURL.startsWith('https://empanadas.io')) {
		event.preventDefault();
	}
  });
  win.loadFile('download.html')
  //win.webContents.openDevTools();
  return win;
}

// Registered once for the life of the app, not per window: on macOS the window
// is recreated when the dock icon is clicked, and ipcMain.handle throws if the
// same channel is registered twice.
function registerIpcHandlers() {
	const target = () => win && !win.isDestroyed() ? win : null;

	ipcMain.handle('window-minimize', () => { const w = target(); if (w) w.minimize(); });
	ipcMain.handle('window-maximize', () => {
		const w = target();
		if (!w) return false;
		if (w.isMaximized()) w.unmaximize();
		else w.maximize();
		return w.isMaximized();
	});
	ipcMain.handle('window-close', () => { const w = target(); if (w) w.close(); });

	ipcMain.handle('update-check', () => updater.checkFromRenderer());
	ipcMain.handle('update-state', () => updater.getState());
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