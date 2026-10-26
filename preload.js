// Bridge for the teleprompter operator and display windows (window.prompter).
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(`pr:${channel}`, ...args);
const on = (channel) => (cb) => {
  const fn = (_e, data) => cb(data);
  ipcRenderer.on(`pr:${channel}`, fn);
  return () => ipcRenderer.removeListener(`pr:${channel}`, fn);
};

contextBridge.exposeInMainWorld('prompter', {
  getConfig: invoke('config:get'),
  cmd: (command, value) => ipcRenderer.invoke('pr:cmd', command, value ?? null),
  updateSettings: invoke('settings:update'),
  setScript: invoke('script:set'),
  newScript: invoke('script:new'),
  openScript: invoke('script:open'),
  saveScript: invoke('script:save'),
  setLayout: invoke('layout'),
  setPosition: invoke('position'),
  getDisplays: invoke('displays:get'),
  toggleDisplay: invoke('display:toggle'),
  closeDisplay: invoke('display:close'),
  remoteStatus: invoke('remote:status'),
  updateStatus: invoke('update:status'),
  checkForUpdates: invoke('update:check'),
  installUpdate: invoke('update:install'),
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  onTransport: on('transport'),
  onConfig: on('config'),
  onScript: on('script'),
  onDisplayState: on('display:state'),
  onDisplaysChanged: on('displays:changed'),
  onRemote: on('remote'),
  onMenu: on('menu'),
  onUpdate: on('update'),
});
