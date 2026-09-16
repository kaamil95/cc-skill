// IPC 契约：白名单与处理器必须一一对应。
// 这两条断言正是 ipc-channels.js 存在的意义——漏登记只会在运行时暴露，这里提前拦住。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('../helpers/harness');
const { IPC_CHANNELS } = require('../../ipc-channels');

let app;
before(async () => {
  app = await startApp();
});
after(() => app.cleanup());

test('白名单里的每个通道都注册了处理器', () => {
  const registered = new Set(app.channels());
  assert.deepEqual(
    IPC_CHANNELS.filter((c) => !registered.has(c)),
    []
  );
});

test('每个注册的处理器都在白名单里', () => {
  const whitelist = new Set(IPC_CHANNELS);
  assert.deepEqual(
    app.channels().filter((c) => !whitelist.has(c)),
    []
  );
});

test('未注册的通道会抛错（而不是静默失败）', () => {
  assert.throws(() => app.invoke('不存在的通道', {}), /未注册的通道/);
});
