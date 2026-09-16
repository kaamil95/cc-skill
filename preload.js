const { contextBridge, ipcRenderer } = require('electron');
const { marked } = require('marked');
const { IPC_CHANNEL_SET } = require('./ipc-channels');

contextBridge.exposeInMainWorld('api', {
  invoke: (ch, payload) => (IPC_CHANNEL_SET.has(ch) ? ipcRenderer.invoke(ch, payload) : Promise.reject(new Error('未知通道: ' + ch))),
  md: (text) => marked.parse(text || '', { gfm: true }),
});
