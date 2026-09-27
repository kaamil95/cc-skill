// HTTP 出口：注入式 fetch + 超时 / 非 2xx / 体积上限。全程不碰真网络。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { setFetchImpl, httpGet, downloadToFile } = require('../../src/net');
const { tmpDir } = require('../helpers/fixtures');

const response = (body = '', { status = 200, headers = {} } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 404 ? 'Not Found' : '',
  headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
  arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  json: async () => JSON.parse(body),
});

test('2xx 正常返回，expectJson 会解析 body', async () => {
  setFetchImpl(async () => response('{"a":1}'));
  const r = await httpGet('https://x.test/a', { expectJson: true });
  assert.deepEqual(r, { a: 1 });
  setFetchImpl(null);
});

test('非 2xx 抛错，且错误里带状态码与 URL（排查时最需要这两样）', async () => {
  setFetchImpl(async () => response('', { status: 404 }));
  await assert.rejects(
    () => httpGet('https://x.test/missing'),
    (err) => /HTTP 404/.test(err.message) && /x\.test\/missing/.test(err.message)
  );
  setFetchImpl(null);
});

test('超时转成可读错误并保留原因', async () => {
  setFetchImpl(
    (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      })
  );
  await assert.rejects(() => httpGet('https://x.test/slow', { timeoutMs: 30 }), /请求超时/);
  setFetchImpl(null);
});

test('downloadToFile 落盘，并按 Content-Length 挡住超大响应', async () => {
  const dir = tmpDir('cc-skill-net-');
  try {
    setFetchImpl(async () => response('hello'));
    const out = path.join(dir, 'a.txt');
    const r = await downloadToFile('https://x.test/a', out);
    assert.equal(r.bytes, 5);
    assert.equal(fs.readFileSync(out, 'utf8'), 'hello');

    setFetchImpl(async () => response('hello', { headers: { 'content-length': '999999999' } }));
    await assert.rejects(() => downloadToFile('https://x.test/big', path.join(dir, 'b.txt'), { maxBytes: 1024 }), /文件过大/);
  } finally {
    setFetchImpl(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('downloadToFile 边收边计数：谎报或不报 content-length 也拦得住', async () => {
  const dir = tmpDir('cc-skill-net-cap-');
  try {
    // 不给 content-length，body 却很大 —— 只有实际字节数说了算
    setFetchImpl(async () => ({
      ok: true,
      status: 200,
      statusText: '',
      headers: { get: () => null },
      body: (async function* () {
        for (let i = 0; i < 10; i++) yield new Uint8Array(100);
      })(),
    }));
    await assert.rejects(() => downloadToFile('https://x.test/big', path.join(dir, 'b.bin'), { maxBytes: 250 }), /文件过大/);
  } finally {
    setFetchImpl(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('下载超时覆盖正文：发完响应头就挂着也会超时', async () => {
  const dir = tmpDir('cc-skill-net-tmo-');
  try {
    // 只等 abort、永不产数据 —— 超时若只盖响应头，这里会一直挂下去
    setFetchImpl(async (_url, { signal }) => ({
      ok: true,
      status: 200,
      statusText: '',
      headers: { get: () => null },
      body: {
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise((_res, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
        }),
      },
    }));
    await assert.rejects(() => downloadToFile('https://x.test/slow', path.join(dir, 's.bin'), { timeoutMs: 40 }), /下载超时/);
  } finally {
    setFetchImpl(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('传入非函数时回落到全局 fetch（不会把注入搞坏）', async () => {
  setFetchImpl('not a function');
  // 打一个必然连不上的本地端口：失败原因必须是网络层的，而不是「fetchImpl 不是函数」
  await assert.rejects(
    () => httpGet('http://127.0.0.1:1/nope', { timeoutMs: 3000 }),
    (err) => !/is not a function/.test(err.message)
  );
});
