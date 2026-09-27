// 代理：配置落盘 + 映射给 session + 测试连接的成败路径。网络请求全部注入假实现。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('../helpers/harness');
const { setFetchImpl } = require('../../src/net');

let app;

before(async () => {
  app = await startApp();
});
after(() => {
  setFetchImpl(null);
  app.cleanup();
});

test('默认跟随系统，且启动时就应用了一次', () => {
  assert.deepEqual(app.proxyConfigs().at(-1), { mode: 'system' });
});

test('proxy:set 写进配置，并把映射交给 session', async () => {
  const r = await app.invoke('proxy:set', { proxy: { mode: 'manual', url: 'http://127.0.0.1:7890', bypass: '*.internal' } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.proxy, { mode: 'manual', url: 'http://127.0.0.1:7890', bypass: '*.internal' });
  assert.equal(app.readConfig().proxy.url, 'http://127.0.0.1:7890');
  assert.deepEqual(app.proxyConfigs().at(-1), {
    mode: 'fixed_servers',
    proxyRules: 'http://127.0.0.1:7890',
    proxyBypassRules: '*.internal,<local>',
  });
});

test('非法模式与非法地址都不会落到配置里', async () => {
  const r = await app.invoke('proxy:set', { proxy: { mode: 'nope', url: 'javascript:alert(1)' } });
  assert.equal(r.proxy.mode, 'system');
  assert.equal(r.proxy.url, '');
  assert.deepEqual(app.proxyConfigs().at(-1), { mode: 'system' });
});

test('直连模式映射成 direct（系统开着代理时也能强制不走代理）', async () => {
  const r = await app.invoke('proxy:set', { proxy: { mode: 'direct' } });
  assert.equal(r.ok, true);
  assert.deepEqual(app.proxyConfigs().at(-1), { mode: 'direct' });
});

test('proxy:test 用界面上刚填的值，测完恢复成已保存的配置', async () => {
  await app.invoke('proxy:set', { proxy: { mode: 'manual', url: 'http://saved:1' } });
  setFetchImpl(async () => ({ ok: true, status: 200, statusText: '', headers: { get: () => null } }));

  const r = await app.invoke('proxy:test', { proxy: { mode: 'manual', url: 'http://typed:2' } });
  assert.equal(r.ok, true);
  assert.equal(typeof r.ms, 'number');

  const lastTwo = app.proxyConfigs().slice(-2);
  assert.equal(lastTwo[0].proxyRules, 'http://typed:2', '测试时应该用填写的值');
  assert.equal(lastTwo[1].proxyRules, 'http://saved:1', '测完必须回到已保存的值');
});

test('proxy:test 失败时回传错误信息而不是抛异常', async () => {
  setFetchImpl(async () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:7890');
  });
  const r = await app.invoke('proxy:test', { proxy: { mode: 'manual', url: 'http://127.0.0.1:7890' } });
  assert.equal(r.ok, false);
  assert.match(r.error, /ECONNREFUSED/);
});

test('代理配置不进云备份（本机地址换台机器就是错的，URL 里还可能带密码）', async () => {
  await app.invoke('proxy:set', { proxy: { mode: 'manual', url: 'http://user:secret@127.0.0.1:7890' } });
  const { buildConfigPayload } = require('../../src/config');
  const payload = JSON.stringify(buildConfigPayload({ includePassword: true }));
  assert.ok(!payload.includes('secret'), '备份包不该带代理凭据');
  assert.ok(!payload.includes('proxy'), '备份包不该带代理配置');
});
