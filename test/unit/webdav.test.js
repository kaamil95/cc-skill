// WebDAV 模块里不依赖网络的纯逻辑：配置归一化、快照指纹、备份名校验
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { initConfig, getConfig } = require('../../src/config');
const { webdavCfg, snapshotHash, BACKUP_NAME_RE } = require('../../src/webdav');
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
