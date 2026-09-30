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

// 踩过：api.github.com 对匿名请求按**出口 IP** 限流（每小时 60 次），走代理时出口是共享
// 节点，一点测试就是 403。旧实现把任何非 2xx 都当成失败，界面于是报「连接失败：HTTP 403」，
// 让人回头去折腾本来好好的代理设置 —— 其实拿到 403 恰恰证明链路是通的。
test('proxy:test 把「连上了但被拒」与「连不上」分开：403 不算代理故障', async () => {
  setFetchImpl(async () => ({ ok: false, status: 403, statusText: 'Forbidden', headers: { get: () => null } }));
  const r = await app.invoke('proxy:test', {});
  assert.equal(r.ok, true, '拿到 HTTP 响应就说明链路通');
  assert.equal(r.httpStatus, 403);
  assert.equal(typeof r.ms, 'number');
});

test('proxy:test 带上市场里配的 GitHub Token（匿名额度是共享出口 IP 的，自己那点额度不经用）', async () => {
  let seen = null;
  setFetchImpl(async (url, opts) => {
    seen = { url, headers: (opts && opts.headers) || {} };
    return { ok: true, status: 200, statusText: '', headers: { get: () => null } };
  });
  await app.invoke('market:setConfig', { token: 'ghp_secret' });
  const r = await app.invoke('proxy:test', {});
  assert.equal(r.ok, true);
  assert.equal(r.httpStatus, undefined, '正常 200 就不该带 httpStatus');
  assert.equal(seen.url, 'https://api.github.com/');
  assert.equal(seen.headers.authorization, 'Bearer ghp_secret');
  await app.invoke('market:setConfig', { token: '' });
});

test('代理配置不进云备份（本机地址换台机器就是错的，URL 里还可能带密码）', async () => {
  await app.invoke('proxy:set', { proxy: { mode: 'manual', url: 'http://user:secret@127.0.0.1:7890' } });
  const { buildConfigPayload } = require('../../src/config');
  const payload = JSON.stringify(buildConfigPayload({ includePassword: true }));
  assert.ok(!payload.includes('secret'), '备份包不该带代理凭据');
  assert.ok(!payload.includes('proxy'), '备份包不该带代理配置');
});
