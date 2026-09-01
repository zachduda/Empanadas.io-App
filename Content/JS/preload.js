const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronWindow', {
  minimize: () => ipcRenderer.invoke('window-minimize'),
  toggleMaximize: () => ipcRenderer.invoke('window-maximize'),
  close: () => ipcRenderer.invoke('window-close'),
});

// Read-only view of the updater. Deliberately no "install" here: the page is
// loaded from the network, and nothing served over the wire should be able to
// quit the app or launch an installer.
contextBridge.exposeInMainWorld('empanadasUpdater', {
  check: () => ipcRenderer.invoke('update-check'),
  getState: () => ipcRenderer.invoke('update-state'),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('updater:state', listener);
    return () => ipcRenderer.removeListener('updater:state', listener);
  },
});
