'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('capture', {
  onCommand: (callback) => ipcRenderer.on('cmd', (_event, data) => callback(data)),
  onPcm: (callback) => ipcRenderer.on('pcm', (_event, data) => callback(data)),
  reply: (id, result) => ipcRenderer.send('cmd-reply', id, result),
  chunk: (data) => ipcRenderer.invoke('rec-chunk', data),
  segment: (data) => ipcRenderer.invoke('rec-segment', data),
  failed: (message) => ipcRenderer.send('rec-failed', message),
  sourceEnded: () => ipcRenderer.send('source-ended'),
});
