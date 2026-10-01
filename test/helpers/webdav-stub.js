// 内存版 WebDAV 桩服务器：够用就行——MKCOL / PROPFIND / PUT / GET / HEAD / DELETE。
// 记录全部请求，便于断言「某个阶段没有发生整包下载」这类行为。
//
// PROPFIND 按 Depth:1 只返回**该目录的直接子项**（含被查询的目录自身），带 resourcetype ——
// 真实服务商就是这么答的，按机器分目录之后，「这台机器有哪些备份」全靠它。
// DELETE 对集合是递归的（RFC 4918 要求），删机器目录就是删它下面的一切。
const http = require('http');

class WebdavStub {
  constructor() {
    this.files = new Map(); // 远程路径 -> Buffer
    this.collections = new Set(); // 已被 MKCOL 建出来的目录
    this.log = []; // { method, url }
    this.delayMs = 0; // 人为延迟，用于验证 UI/时序
    this.corruptZip = false;
    this.base = null; // 远程根目录；不设就从实际上传路径推 // GET zip 时返回垃圾数据
    this.hideMeta = false; // GET 备份侧车（<zip>.json）返回 404（模拟侧车没写成功）
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
    // 只算整包：每份备份旁边还有一份 <zip>.json 侧车，读它不算「下载整包」
    return this.requests('GET', '.zip').filter((e) => !e.url.endsWith('.json'));
  }

  /** 远程根目录（各远程目录配置不同，从实际路径推；也可以直接写 this.base 覆盖） */
  basePath() {
    if (this.base) return this.base;
    const first = [...this.files.keys()][0];
    if (!first) return '/dav';
    // /dav/<机器目录>/<文件> → 去掉最后两段
    const segs = first.split('/').filter(Boolean);
    return '/' + segs.slice(0, Math.max(1, segs.length - 2)).join('/');
  }

  /** 云端根目录下的一台台机器（目录名） */
  machineDirs() {
    const prefix = this.basePath() + '/';
    const out = new Set();
    const push = (p) => {
      if (!p.startsWith(prefix)) return;
      const seg = p.slice(prefix.length).split('/')[0];
      if (seg) out.add(seg);
    };
    for (const p of this.files.keys()) push(p);
    for (const c of this.collections) push(c + '/');
    return [...out].sort();
  }

  /** 某个目录下的直接文件名 */
  filesIn(dir) {
    const prefix = `${this.basePath()}/${dir}/`;
    return [...this.files.keys()]
      .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
      .map((p) => p.slice(prefix.length))
      .sort();
  }

  /** 某台机器的备份包名（按文件名排序） */
  backupsIn(dir) {
    return this.filesIn(dir).filter((f) => f.endsWith('.zip'));
  }

  /** 目录下唯一的那个 zip；没有就 null */
  zipIn(dir) {
    return this.backupsIn(dir)[0] || null;
  }

  /** 云端任意一个 zip 的完整路径（不关心是哪台机器的） */
  zipPath() {
    return [...this.files.keys()].find((k) => k.endsWith('.zip')) || null;
  }

  /** 某个 zip 的侧车路径（测试里伪造 / 删除侧车用） */
  sidecarOf(dir, zip) {
    return `${this.basePath()}/${dir}/${zip}.json`;
  }

  machineProfilePath(dir) {
    return `${this.basePath()}/${dir}/machine.json`;
  }

  /** 直接改远端文件内容，用于伪造「别的机器上传的备份」「档案坏掉」等场景 */
  writeJson(key, obj) {
    this.files.set(key, Buffer.from(JSON.stringify(obj), 'utf8'));
  }

  remove(key) {
    this.files.delete(key);
  }

  readJson(key) {
    const buf = this.files.get(key);
    return buf ? JSON.parse(buf.toString('utf8')) : null;
  }

  /** 目录的直接子项：路径 -> 是不是集合 */
  _children(dir) {
    const prefix = dir === '/' ? '/' : dir + '/';
    const out = new Map();
    const add = (p, isColl) => {
      if (!p.startsWith(prefix)) return; // 别的目录下的东西不是这里的孩子
      const rest = p.slice(prefix.length);
      if (!rest) return;
      const seg = prefix + rest.split('/')[0];
      out.set(seg, out.get(seg) || rest.includes('/') || isColl);
    };
    for (const p of this.files.keys()) add(p, false);
    for (const c of this.collections) add(c + '/', true);
    return out;
  }

  async _handle(req, res) {
    this.log.push({ method: req.method, url: req.url });
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));

    const key = decodeURIComponent(req.url.split('?')[0]);
    const dir = key.replace(/\/+$/, '') || '/';

    if (req.method === 'MKCOL') {
      this.collections.add(dir);
      res.writeHead(201);
      return res.end();
    }

    if (req.method === 'PROPFIND') {
      // 目录不存在要如实返回 404，否则测不出「自动创建远程目录」这条路径
      const exists = this.collections.has(dir) || [...this.files.keys()].some((p) => p.startsWith(dir === '/' ? '/' : dir + '/'));
      if (!exists) {
        res.writeHead(404);
        return res.end();
      }
      const one = (p, isColl) =>
        `<D:response><D:href>${p}${isColl ? '/' : ''}</D:href><D:resourcetype>${isColl ? '<D:collection/>' : ''}</D:resourcetype></D:response>`;
      const body = [one(dir, true), ...[...this._children(dir)].map(([p, isColl]) => one(p, isColl))].join('');
      res.writeHead(207, { 'Content-Type': 'application/xml' });
      return res.end(`<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">${body}</D:multistatus>`);
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
      let touched = this.files.delete(key);
      for (const k of [...this.files.keys()]) {
        if (k.startsWith(dir + '/')) {
          this.files.delete(k);
          touched = true;
        }
      }
      for (const c of [...this.collections]) {
        if (c === dir || c.startsWith(dir + '/')) {
          this.collections.delete(c);
          touched = true;
        }
      }
      res.writeHead(touched ? 204 : 404);
      return res.end();
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (this.hideMeta && key.endsWith('.zip.json')) {
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
