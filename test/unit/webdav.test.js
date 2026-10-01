// WebDAV 模块里不依赖网络的纯逻辑：配置归一化、快照指纹、备份名校验、
// 云端目录名与 PROPFIND 解析
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { initConfig, getConfig } = require('../../src/config');
const { webdavCfg, snapshotHash, BACKUP_NAME_RE, slugify, machineDirName, machineIdFromDir, createdFromName, parsePropfind } = require('../../src/webdav');
const { writeSkill } = require('../helpers/fixtures');

let root;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-skill-unit-webdav-'));
  initConfig(root); // 目录为空 → 写入默认配置
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

const setWebdav = (w) => {
  getConfig().webdav = w;
};

test('webdavCfg 归一化远程路径的各种斜杠写法', () => {
  const cases = [
    ['//a//b/', '/a/b'],
    ['/cc-skill-sync/', '/cc-skill-sync'],
    ['a', '/a'],
    ['', '/cc-skill-sync'],
    [undefined, '/cc-skill-sync'],
  ];
  for (const [input, expected] of cases) {
    setWebdav({ url: 'https://dav.example.com/dav', remotePath: input });
    assert.equal(webdavCfg().remotePath, expected, `输入 ${JSON.stringify(input)}`);
  }
});

test('webdavCfg 去掉地址尾部的斜杠', () => {
  setWebdav({ url: 'https://dav.example.com/dav///', remotePath: 'x' });
  assert.equal(webdavCfg().url, 'https://dav.example.com/dav');
});

test('webdavCfg 对缺省字段给出安全默认值', () => {
  setWebdav({});
  const cfg = webdavCfg();
  assert.equal(cfg.url, '');
  assert.equal(cfg.username, '');
  assert.equal(cfg.password, '');
  assert.equal(cfg.autoBackup, false);
  assert.equal(cfg.autoBackupFreq, 'startup');
  assert.equal(cfg.lastBackupAt, 0);
  assert.equal(cfg.lastBackupHash, '');
});

test('webdavCfg 兼容 config 里完全没有 webdav 字段', () => {
  delete getConfig().webdav;
  assert.equal(webdavCfg().remotePath, '/cc-skill-sync');
});

test('snapshotHash 对同一份内容稳定，内容变了就变', () => {
  const dir = path.join(root, 'snap');
  writeSkill(dir, 'one');
  const items = [{ folder: 'one', absPath: path.join(dir, 'one') }];

  const h1 = snapshotHash(items);
  const h2 = snapshotHash(items);
  assert.equal(h1, h2, '同样的内容应得到同样的指纹');
  assert.match(h1, /^[0-9a-f]{64}$/);

  fs.writeFileSync(path.join(dir, 'one', 'extra.md'), '新文件', 'utf8');
  assert.notEqual(snapshotHash(items), h1, '新增文件后指纹应变化');

  const renamed = [{ folder: 'renamed', absPath: path.join(dir, 'one') }];
  assert.notEqual(snapshotHash(renamed), snapshotHash(items), '文件夹改名也应算变化');
});

test('snapshotHash 对空列表给出确定值', () => {
  assert.equal(snapshotHash([]), snapshotHash([]));
});

test('备份名正则只接受规范的文件名', () => {
  const ok = ['cc-skill-backup-20260101-000000.zip', 'cc-skill-backup-20260101-000000-2.zip'];
  for (const n of ok) assert.ok(BACKUP_NAME_RE.test(n), `${n} 应通过`);

  const bad = [
    '../../evil.zip',
    'cc-skill-backup-../x.zip',
    'cc-skill-backup-a/b.zip',
    'cc-skill-backup-a\\b.zip',
    'other.zip',
    'cc-skill-backup-x.txt',
    '',
    'cc-skill-backup-.zip',
  ];
  for (const n of bad) assert.ok(!BACKUP_NAME_RE.test(n), `${JSON.stringify(n)} 不该通过`);
});

// ------------------------------ 云端目录名 ------------------------------------
test('slug 只留 ASCII：非 ASCII 与符号一律折成 -，免得 WebDAV 路径编码出岔子', () => {
  assert.equal(slugify('kai-PC'), 'kai-pc');
  assert.equal(slugify('kaiのPC'), 'kai-pc', '日文折成 -，不会留在目录名里');
  assert.equal(slugify('我的 台式机'), '', '整串非 ASCII → 空 slug');
  assert.equal(slugify('  a  b  '), 'a-b', '连续分隔折成一个');
  assert.equal(slugify('-a-'), 'a', '首尾的 - 去掉');
  assert.equal(slugify('a'.repeat(50)).length, 24, '限长，别让目录名无限长');
  assert.equal(slugify('a'.repeat(23) + '!'), 'a'.repeat(23), '截断后不留尾巴 -');
  assert.equal(slugify(''), '');
  assert.equal(slugify(null), '');
});

test('目录名 = slug + 完整标识；slug 为空时只用标识', () => {
  const id = '8c2f1d4e-1a2b-4c3d-9e8f-0123456789ab';
  assert.equal(machineDirName(id, 'kai-PC'), `kai-pc-${id}`);
  assert.equal(machineDirName(id, '我的台式机'), id, '名字里没有 ASCII 时不留一个孤零零的 -');
  assert.equal(machineDirName(id, ''), id);
});

test('目录名尾部的标识能被认回来（machine.json 坏掉时的兜底）', () => {
  const id = '8c2f1d4e-1a2b-4c3d-9e8f-0123456789ab';
  assert.equal(machineIdFromDir(`kai-pc-${id}`), id);
  assert.equal(machineIdFromDir(id), id);
  assert.equal(machineIdFromDir('kai-pc'), '', '没有标识就是没有');
  assert.equal(machineIdFromDir('kai-pc-8c2f1d4e-1a2b-4c3d-9e8f'), '', '不完整的 UUID 不算');
  assert.equal(machineIdFromDir(''), '');
});

test('备份名里的时间戳能还原成时间（列表里非最新的那些靠它，省一次请求）', () => {
  const iso = createdFromName('cc-skill-backup-20260101-013005.zip');
  assert.equal(iso, new Date(2026, 0, 1, 1, 30, 5).toISOString(), '按本地时间解析（文件名就是本机写下的）');
  assert.equal(createdFromName('other.zip'), '', '认不出来就给空串，不要编一个时间');
});

// ------------------------------ PROPFIND 解析 --------------------------------
const resp = (href, coll = false) => `<D:response><D:href>${href}</D:href><D:resourcetype>${coll ? '<D:collection/>' : ''}</D:resourcetype></D:response>`;

test('PROPFIND 解析：区分目录与文件，命名空间前缀可有可无', () => {
  const xml = `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">
    ${resp('/dav/cc-skill-sync/', true)}
    ${resp('/dav/cc-skill-sync/kai-pc-abc/', true)}
    ${resp('/dav/cc-skill-sync/kai-pc-abc/cc-skill-backup-20260101-000000.zip')}
    ${resp('/dav/cc-skill-sync/machine.json')}
  </D:multistatus>`;
  const { dirs, files } = parsePropfind(xml);
  assert.deepEqual([...dirs].sort(), ['cc-skill-sync', 'kai-pc-abc']);
  assert.deepEqual([...files].sort(), ['cc-skill-backup-20260101-000000.zip', 'machine.json']);

  // 没有前缀、或换个前缀（Nextcloud 用小写 d）都认
  const plain = `<multistatus>${resp('/dav/x/', true)}${resp('/dav/y.zip')}</multistatus>`;
  assert.deepEqual([...parsePropfind(plain).dirs], ['x']);
  const lower = `<d:multistatus>${resp('/dav/x/', true)}</d:multistatus>`;
  assert.deepEqual([...parsePropfind(lower).dirs], ['x']);
});

test('PROPFIND 解析：URL 编码的名字要还原', () => {
  const { dirs } = parsePropfind(`<D:multistatus>${resp('/dav/%E4%B8%AD%E6%96%87%20dir/', true)}</D:multistatus>`);
  assert.deepEqual([...dirs], ['中文 dir']);
});

test('PROPFIND 解析：只取最后一段，.. 这类名字一律丢掉', () => {
  // 名字直接来自服务端，会被拼进后续请求的 URL —— 一个说谎的服务器可以借此让客户端
  // 去删同主机上别的路径。防线是「只取最后一段 + 那一段必须是单个路径片段」：
  // 带 .. 的 href 落不到别的目录上，多段路径也只会缩成最后那一个名字
  const { dirs, files } = parsePropfind(`<D:multistatus>${resp('/dav/cc-skill-sync/..', true)}${resp('/dav/cc-skill-sync/.', true)}</D:multistatus>`);
  assert.deepEqual([...dirs], [], '.. 与 . 不是合法的子项名');
  assert.deepEqual([...files], []);

  const collapse = (href) => [...parsePropfind(`<D:multistatus>${resp(href)}</D:multistatus>`).files];
  assert.deepEqual(collapse('/dav/x/../../whatever.zip'), ['whatever.zip'], '穿越段被缩掉，剩下的仍只是本目录下的一个名字');
  assert.deepEqual(collapse('/dav/a%2Fb.zip'), ['b.zip'], '编码过的分隔符解码后同样只留最后一段');
});

test('PROPFIND 解析：坏 XML / 空输入不抛异常', () => {
  for (const xml of ['', null, undefined, '不是 xml', '<D:multistatus><D:response></D:response></D:multistatus>']) {
    const r = parsePropfind(xml);
    assert.deepEqual([...r.dirs, ...r.files], [], `输入 ${JSON.stringify(xml)} 应当安静地给出空结果`);
  }
});
