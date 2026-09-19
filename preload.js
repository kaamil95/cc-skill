const { contextBridge, ipcRenderer } = require('electron');
const { marked } = require('marked');
const { IPC_CHANNEL_SET } = require('./ipc-channels');

contextBridge.exposeInMainWorld('api', {
  invoke: (ch, payload) => (IPC_CHANNEL_SET.has(ch) ? ipcRenderer.invoke(ch, payload) : Promise.reject(new Error('未知通道: ' + ch))),
  md: (text) => marked.parse(text || '', { gfm: true }),
  // 主进程主动推送的事件（自动备份结果）。事件是主→渲染单向的，不涉及通道越权
  onSyncAuto: (cb) => ipcRenderer.on('sync:autoResult', (_e, r) => cb(r)),
});
