'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('overlay', {
  onTime: (callback) => ipcRenderer.on('time', (_event, data) => callback(data)),
  onShow: (callback) => ipcRenderer.on('show', (_event, data) => callback(data)),
});
