const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronWindow', {
  minimize: () => ipcRenderer.invoke('window-minimize'),
  toggleMaximize: () => ipcRenderer.invoke('window-maximize'),
  close: () => ipcRenderer.invoke('window-close'),
});
