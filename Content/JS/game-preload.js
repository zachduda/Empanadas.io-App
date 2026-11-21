'use strict';

// What the games see of the app: only what the site's games already ask for.
//
// window.electronWindow.background is the Keep Spinning When Closed switch in
// the Spin Game's settings (backgroundBridge() in the site's _spin.js). The
// window's own controls are the app's title bar now, so the games are told
// there are native ones and draw none of their own.
//
// Nothing here can reach the account or its data: the games already have
// the site's own cookies for their saves, as they would in a browser.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronWindow', {
	hasNativeControls: true,
	platform: process.platform,
	isMac: process.platform === 'darwin',
	// Keep Spinning When Closed (lib/background.js). status() and set(enabled)
	// resolve { available, enabled }.
	background: {
		status: () => ipcRenderer.invoke('background-status'),
		set: (enabled) => ipcRenderer.invoke('background-set', enabled === true)
	}
});
