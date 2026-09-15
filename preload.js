const { contextBridge, ipcRenderer } = require('electron');
const { marked } = require('marked');

const CHANNELS = new Set([
  'scan',
  'config:get', 'config:set', 'config:reset',
  'skill:read', 'skill:write', 'skill:files', 'skill:copy', 'skill:trash', 'skill:create', 'skill:compare',
  'dialog:pickFolder', 'dialog:pickZip', 'import:inspect',
  'shell:openPath', 'app:paths', 'log:append',
  'sync:getConfig', 'sync:setConfig', 'sync:test', 'sync:backup', 'sync:restorePreview', 'sync:restoreApply', 'sync:autoCheck', 'win:minimize', 'win:maximize', 'win:close',
]);

contextBridge.exposeInMainWorld('api', {
  invoke: (ch, payload) =>
    CHANNELS.has(ch)
      ? ipcRenderer.invoke(ch, payload)
      : Promise.reject(new Error('未知通道: ' + ch)),
  md: (text) => marked.parse(text || '', { gfm: true }),
});
