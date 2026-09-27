// 统一的 HTTP 出口。
//
// 默认用全局 fetch；Electron 主进程启动时会注入 net.fetch —— 后者走 Chromium 的网络栈，
// 因此认得 session 上配置的代理（系统代理 / PAC / 手动代理），而 Node 的全局 fetch 一概不认。
// 刻意不依赖 electron：测试里注入假实现即可，全程不碰真网络。
const fs = require('fs');

let fetchImpl = (...args) => fetch(...args);

/** 注入 fetch 实现（main.js 传 net.fetch；测试传假实现）。传非函数则退回全局 fetch */
function setFetchImpl(fn) {
  fetchImpl = typeof fn === 'function' ? fn : (...args) => fetch(...args);
}

const httpFetch = (url, opts) => fetchImpl(url, opts);

const DEFAULT_TIMEOUT = 30000;
// 下载上限：市场包不该有几百 MB，超了直接拒，免得把磁盘写满
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;

/**
 * 超时 + 非 2xx 都转成带 URL 的可读错误：出错时最需要知道的就是「请求的是哪个地址」。
 * 调用方自带 signal 时不再自建计时器——下载要把「响应头 + 正文」整段纳入超时，
 * 那段的边界只有 downloadToFile 知道。
 */
async function httpGet(url, { headers, timeoutMs = DEFAULT_TIMEOUT, expectJson = false, signal } = {}) {
  const own = !signal;
  const ac = own ? new AbortController() : null;
  const timer = own ? setTimeout(() => ac.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(url, { headers, signal: signal || ac.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}${res.statusText ? ' ' + res.statusText : ''} · ${url}`);
    return expectJson ? await res.json() : res;
  } catch (err) {
    if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      throw new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）：${url}`, { cause: err });
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 下载到文件。三件事都是必须的：
 * 1. 超时覆盖到正文——只盖响应头的话，服务端发完头就挂着会一直等下去
 * 2. 边收边计数——content-length 可以谎报也可以不报，只有实际字节数说了算
 * 3. 超限立刻 abort 并丢弃，别把整个 body 收进内存再判断
 */
async function downloadToFile(url, destPath, { headers, timeoutMs = 120000, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await httpGet(url, { headers, signal: ac.signal });
    const declared = Number(res.headers && res.headers.get ? res.headers.get('content-length') : 0);
    if (declared && declared > maxBytes) throw new Error(`文件过大（${Math.round(declared / 1048576)} MB）：${url}`);

    const chunks = [];
    let total = 0;
    if (res.body) {
      for await (const chunk of res.body) {
        total += chunk.length;
        if (total > maxBytes) {
          ac.abort();
          throw new Error(`文件过大（超过 ${Math.round(maxBytes / 1048576)} MB）：${url}`);
        }
        chunks.push(Buffer.from(chunk));
      }
    } else {
      // 极少数实现不给 body 流（例如桩）：退回一次性读取，仍然过一遍上限
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) throw new Error(`文件过大（${Math.round(buf.length / 1048576)} MB）：${url}`);
      chunks.push(buf);
      total = buf.length;
    }
    fs.writeFileSync(destPath, Buffer.concat(chunks));
    return { ok: true, bytes: total, path: destPath };
  } catch (err) {
    if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      throw new Error(`下载超时（${Math.round(timeoutMs / 1000)} 秒）：${url}`, { cause: err });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { setFetchImpl, httpFetch, httpGet, downloadToFile, DEFAULT_TIMEOUT, DEFAULT_MAX_BYTES };
