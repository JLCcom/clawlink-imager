// preload.js — contextBridge
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clImager', {
  checkSerial:    (serial)   => ipcRenderer.invoke('serial:check', serial),
  getOsManifest:  ()         => ipcRenderer.invoke('os:manifest'),
  listDrives:     ()         => ipcRenderer.invoke('drives:list'),
  downloadImage:  (opts)     => ipcRenderer.invoke('image:download', opts),
  writeSD:        (opts)     => ipcRenderer.invoke('sd:write', opts),
  injectBoot:     (opts)     => ipcRenderer.invoke('boot:inject', opts),
  onDownloadProgress: (fn)   => ipcRenderer.on('download:progress', (_e, v) => fn(v)),
  onWriteProgress:    (fn)   => ipcRenderer.on('write:progress',    (_e, v) => fn(v)),
});
