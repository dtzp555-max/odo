'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('odo', {
  platform: process.platform,
  version: '0.10.0',
  isElectron: true,

  gateway: {
    status: () => ipcRenderer.invoke('gateway:status'),
    start: () => ipcRenderer.invoke('gateway:start'),
    stop: () => ipcRenderer.invoke('gateway:stop'),
    restart: () => ipcRenderer.invoke('gateway:restart'),
  },

  ocm: {
    api: (method, path, body) =>
      ipcRenderer.invoke('ocm:api', { method, path, body }),
  },
});
