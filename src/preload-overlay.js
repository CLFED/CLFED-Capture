'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('overlay', {
  onShow: (callback) => ipcRenderer.on('show', (_event, data) => callback(data)),
});
