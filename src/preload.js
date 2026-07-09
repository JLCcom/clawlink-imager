// preload.js — contextBridge
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clImager', {
  checkSerial:    (serial)   => ipcRenderer.invoke('serial:check', serial),
  getOsManifest:  ()         => ipcRenderer.invoke('os:manifest'),
  listDrives:     ()         => ipcRenderer.invoke('drives:list'),
  prepareImage:   ()         => ipcRenderer.invoke('image:prepare'),
  pickLocalImage: ()         => ipcRenderer.invoke('image:pickLocal'),
  writeSD:        (opts)     => ipcRenderer.invoke('sd:write', opts),
  injectBoot:     (opts)     => ipcRenderer.invoke('boot:inject', opts),
  onPrepareProgress:  (fn)   => ipcRenderer.on('prepare:progress', (_e, p) => fn(p)),
  onWriteProgress:    (fn)   => ipcRenderer.on('write:progress',    (_e, v) => fn(v)),
  onSetLanguage:      (fn)   => ipcRenderer.on('set-language', (_e, code) => fn(code)),
});
