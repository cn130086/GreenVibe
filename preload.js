// preload.js —— 只暴露最小、最安全的桥接接口给渲染进程
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  playMpv: (opts) => ipcRenderer.invoke('play-mpv', opts),
  launchExternal: (opts) => ipcRenderer.invoke('launch-external', opts),
  downloadVideo: (opts) => ipcRenderer.invoke('download-video', opts),
  openExternalLink: (url) => ipcRenderer.invoke('open-external-link', url)
});
