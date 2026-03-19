'use strict';

// Preload script — runs in renderer before page loads
// Currently minimal; will be expanded for IPC bridge in future phases

const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('odo', {
  platform: process.platform,
  version: '0.9.6',
  isElectron: true
});
