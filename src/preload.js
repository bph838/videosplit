const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openVideo: () => ipcRenderer.invoke('open-video'),
  loadDroppedFile: (file) => ipcRenderer.invoke('load-path', webUtils.getPathForFile(file)),
  exportClip: (opts) => ipcRenderer.invoke('export-clip', opts),
  onExportProgress: (cb) => ipcRenderer.on('export-progress', (_e, p) => cb(p)),
});
