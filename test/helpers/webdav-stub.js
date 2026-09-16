// 内存版 WebDAV 桩服务器：够用就行——MKCOL / PROPFIND / PUT / GET / HEAD / DELETE。
// 记录全部请求，便于断言「某个阶段没有发生整包下载」这类行为。
const http = require('http');

class WebdavStub {
  constructor() {
    this.files = new Map(); // 远程路径 -> Buffer
    this.collections = new Set(); // 已被 MKCOL 建出来的目录
    this.log = []; // { method, url }
    this.delayMs = 0; // 人为延迟，用于验证 UI/时序
    this.corruptZip = false; // GET zip 时返回垃圾数据
    this.hideMeta = false; // GET latest.json 返回 404（模拟旧备份）
    this.server = null;
    this.url = '';
  }

  async start() {
    this.server = http.createServer((req, res) => this._handle(req, res));
    await new Promise((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${this.server.address().port}`;
    return this.url;
  }

  stop() {
    if (this.server) this.server.close();
  }

  requests(method, contains) {
    return this.log.filter((e) => (!method || e.method === method) && (!contains || e.url.includes(contains)));
  }

  /** 所有整包 zip 的下载请求——「确认前不该下载整包」就是断言这个为空 */
  zipDownloads() {
    return this.requests('GET', '.zip');
  }

  metaPath() {
    return '/dav/latest.json';
  }

  zipPath() {
    const name = [...this.files.keys()].find((k) => k.endsWith('.zip'));
    return name || null;
  }

  readJson(key) {
    const buf = this.files.get(key);
    return buf ? JSON.parse(buf.toString('utf8')) : null;
  }

  async _handle(req, res) {
    this.log.push({ method: req.method, url: req.url });
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));

    const key = req.url.split('?')[0];

    if (req.method === 'MKCOL') {
      this.collections.add(key.replace(/\/$/, '') || '/');
      res.writeHead(201);
      return res.end();
    }

    if (req.method === 'PROPFIND') {
      // 目录不存在要如实返回 404，否则测不出「自动创建远程目录」这条路径
      const dir = key.replace(/\/$/, '') || '/';
      const exists = this.collections.has(dir) || [...this.files.keys()].some((p) => p.startsWith(dir + '/'));
      if (!exists) {
        res.writeHead(404);
        return res.end();
      }
      const hrefs = [...this.files.keys()].map((p) => `<D:response><D:href>${p}</D:href></D:response>`).join('');
      res.writeHead(207, { 'Content-Type': 'application/xml' });
      return res.end(`<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">${hrefs}</D:multistatus>`);
    }

    if (req.method === 'PUT') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        this.files.set(key, Buffer.concat(chunks));
        res.writeHead(201);
        res.end();
      });
      return;
    }

    if (req.method === 'DELETE') {
      this.files.delete(key);
      res.writeHead(204);
      return res.end();
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (this.hideMeta && key === this.metaPath()) {
        res.writeHead(404);
        return res.end();
      }
      const buf = this.files.get(key);
      if (!buf) {
        res.writeHead(404);
        return res.end();
      }
      const body = this.corruptZip && key.endsWith('.zip') ? Buffer.from('这不是一个 zip') : buf;
      res.writeHead(200, {
        'Content-Type': key.endsWith('.zip') ? 'application/zip' : 'application/json',
        'Content-Length': String(body.length),
        'Last-Modified': new Date().toUTCString(),
      });
      return res.end(req.method === 'HEAD' ? undefined : body);
    }

    res.writeHead(404);
    res.end();
  }
}

module.exports = { WebdavStub };
