const {app, BrowserWindow, Menu, shell} = require('electron');

let win;

if (process.defaultApp) {
  if (process.argv.length >= 2) {
	const path = require('path');
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
//log.info('App starting...');

function sendStatusToWindow(text) {
  //log.info(text);
  win.webContents.send('message', text);
}

function createDefaultWindow() {
  win = new BrowserWindow({
    width: 995,
    height: 600,
	webviewTag: true,
	frame: false,
	minWidth: 995,
	minHeight: 480,
	movable: true,
	minimizable: true,
	resizeable: true,
	title: 'Empanadas.io',
	backgroundColor: '#3a57e8',
	transparent: false,
	webPreferences: {
      webSecurity: true,
      nodeIntegration: false,
	  disableBlinkFeatures: "Auxclick",
	  "sandbox": true,
	  devTools: true
	},
	zoomFactor: 1.05,
	javascript: true,
	icon: 'icon.png' 
  })
  win.on('closed', () => {
    win = null;
  });
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

app.on('ready', function() {
  createDefaultWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
	  app.quit();
  }
});