// preload.js — contextBridge
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clImager', {
  checkSerial:    (serial)   => ipcRenderer.invoke('serial:check', serial),
  getOsManifest:  ()         => ipcRenderer.invoke('os:manifest'),
  listDrives:     ()         => ipcRenderer.invoke('drives:list'),
  prepareImage:   ()         => ipcRenderer.invoke('image:prepare'),
  pickLocalImage: ()         => ipcRenderer.invoke('image:pickLocal'),
  burnSD:         (opts)     => ipcRenderer.invoke('sd:burn', opts),
  onPrepareProgress:  (fn)   => ipcRenderer.on('prepare:progress', (_e, p) => fn(p)),
  onBurnProgress:     (fn)   => ipcRenderer.on('burn:progress',    (_e, p) => fn(p)),
  onSetLanguage:      (fn)   => ipcRenderer.on('set-language', (_e, code) => fn(code)),
});
