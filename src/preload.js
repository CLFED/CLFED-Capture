'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('clfed', {
  init: () => ipcRenderer.invoke('init'),
  action: (name, value) => ipcRenderer.invoke('action', name, value),
  apply: (settings) => ipcRenderer.invoke('apply', settings),
  saveTiming: (timing) => ipcRenderer.invoke('save-timing', timing),
  setLanguage: (language) => ipcRenderer.invoke('set-language', language),
  setAudioOffset: (value) => ipcRenderer.invoke('set-audio-offset', value),
  setStartup: (enabled) => ipcRenderer.invoke('set-startup', enabled),
  setVolume: (name, value) => ipcRenderer.invoke('set-volume', name, value),
  setHotkey: (name, accelerator) => ipcRenderer.invoke('set-hotkey', name, accelerator),
  resetHotkeys: () => ipcRenderer.invoke('reset-hotkeys'),
  windows: () => ipcRenderer.invoke('list-windows'),
  mics: () => ipcRenderer.invoke('list-mics'),
  clips: () => ipcRenderer.invoke('clips'),
  clip: (name, file, value) => ipcRenderer.invoke('clip', name, file, value),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  on: (channel, callback) => ipcRenderer.on(channel, (_event, data) => callback(data)),
});
