// 渲染进程允许调用的 IPC 通道白名单——唯一来源。
// preload.js 用它拦截未授权通道；main.js 注册处理器时用它断言，避免「加了 handle 却忘了进白名单」
// 这类只在运行时才暴露的问题。新增通道只需在这里加一项。
const IPC_CHANNELS = [
  'scan',
  'config:get',
  'config:set',
  'config:reset',
  'skill:read',
  'skill:write',
  'skill:files',
  'skill:copy',
  'skill:trash',
  'skill:create',
  'skill:compare',
  'dialog:pickFolder',
  'dialog:pickZip',
  'import:inspect',
  'shell:openPath',
  'app:paths',
  'log:append',
  'sync:getConfig',
  'sync:setConfig',
  'sync:test',
  'sync:backup',
  'sync:restoreInfo',
  'sync:restoreApply',
  'win:minimize',
  'win:maximize',
  'win:close',
];

module.exports = { IPC_CHANNELS, IPC_CHANNEL_SET: new Set(IPC_CHANNELS) };
