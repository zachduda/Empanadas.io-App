// no updater stuff -- const {autoUpdater} = require("electron-updater");
const {app, BrowserWindow, ipcMain} = require('electron');
const path = require('path');

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
	})
}

process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = false;

function createDefaultWindow() {
	win = new BrowserWindow({
    width: 1100,
    height: 700,
	webviewTag: true,
	frame: false,
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
  
	//const electronDl = require('electron-dl');
	//electronDl();
	
// {download} = require('electron-dl');

//ipcMain.on('download-button', async (event, {url}) => {
 	//const win = BrowserWindow.getFocusedWindow();
 	//console.log(await download(win, url));
//});

	ipcMain.handle('window-minimize', () => win.minimize());
	ipcMain.handle('window-maximize', () => {
		if (win.isMaximized()) win.unmaximize();
		else win.maximize();
		return win.isMaximized();
	});
	ipcMain.handle('window-close', () => win.close());


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

app.on('ready', function()  {
//  autoUpdater.checkForUpdatesAndNotify();
  createDefaultWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
	  app.quit();
  }
});