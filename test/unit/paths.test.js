// 路径与平台工具——纯函数
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { expand, toTilde, basenameOf, ps, IS_WIN, LINK_TYPE, tempDir, setTempDir, sweepStaleTempDirs, resolveDataDir } = require('../../src/paths');
const { tmpDir } = require('../helpers/fixtures');

test('expand 把 ~ 展开成用户主目录', () => {
  assert.equal(expand('~/.claude/skills'), path.join(os.homedir(), '.claude', 'skills'));
  assert.equal(expand('~/'), os.homedir() + path.sep);
});

test('expand 对绝对路径 / 空值原样返回', () => {
  assert.equal(expand('C:\\x\\y'), 'C:\\x\\y');
  assert.equal(expand(''), '');
  assert.equal(expand(null), null);
  assert.equal(expand(undefined), undefined);
});

test('toTilde 把主目录下的路径收敛成 ~ 形式', () => {
  assert.equal(toTilde(path.join(os.homedir(), '.claude', 'skills')), '~/.claude/skills');
});

test('toTilde 对主目录之外的路径原样返回', () => {
  const outside = IS_WIN ? 'D:\\elsewhere\\skills' : '/elsewhere/skills';
  assert.equal(toTilde(outside), outside);
  assert.equal(toTilde(''), '');
  assert.equal(toTilde(null), '');
});

test('expand / toTilde 互为逆运算', () => {
  const abs = path.join(os.homedir(), 'a', 'b', 'c');
  assert.equal(expand(toTilde(abs)), abs);
});

test('toTilde 大小写不敏感（Windows 盘符与用户名大小写）', () => {
  const upper = path.join(os.homedir().toUpperCase(), 'skills');
  assert.equal(toTilde(upper), '~/skills');
});

test('toTilde 做分隔符边界判断，不把「同前缀的兄弟目录」误当成用户目录', () => {
  const home = os.homedir();
  // home 是 C:\Users\kai 时，C:\Users\kaix 绝不能被收敛成 ~/x —— 那是不可逆的路径污染
  assert.equal(toTilde(home + 'x'), home + 'x');
  assert.equal(toTilde(home + 'x' + path.sep + 'skills'), home + 'x' + path.sep + 'skills');
});

test('用户目录自身收敛成 ~ 而不是 ~/', () => {
  assert.equal(toTilde(os.homedir()), '~');
  assert.equal(expand('~'), os.homedir());
});

test('expand 只把 ~ 后紧跟分隔符的路径当作家目录', () => {
  assert.equal(expand('~foo'), '~foo');
});

test('toTilde 兼容正斜杠写法（Windows 上 C:\\a 与 C:/a 是同一个目录）', () => {
  const fwd = os.homedir().split('\\').join('/');
  assert.equal(toTilde(fwd + '/skills'), '~/skills');
  assert.equal(toTilde(fwd), '~');
  assert.equal(toTilde(os.homedir() + '/skills'), '~/skills', '混合分隔符也要认出来');
});

test('toTilde 保留原始大小写（只有比对是小写化的）', () => {
  const mixed = path.join(os.homedir(), 'AppData', 'Local', 'Temp', 'MixedCase');
  assert.equal(toTilde(mixed), '~/AppData/Local/Temp/MixedCase');
});

test('basenameOf 兼容两种分隔符', () => {
  assert.equal(basenameOf('C:\\a\\b\\proj'), 'proj');
  assert.equal(basenameOf('/a/b/proj'), 'proj');
  assert.equal(basenameOf('proj'), 'proj');
  assert.equal(basenameOf(''), '');
  assert.equal(basenameOf(null), '');
});

test('ps 转义 PowerShell 单引号', () => {
  assert.equal(ps("C:\\it's\\here"), "C:\\it''s\\here");
  assert.equal(ps('plain'), 'plain');
});

test('链接类型与平台匹配', () => {
  assert.equal(LINK_TYPE, IS_WIN ? 'junction' : 'dir');
});

test('tempDir 可被宿主覆盖，默认回落到系统临时目录', () => {
  const original = tempDir();
  setTempDir('C:\\fake\\temp');
  assert.equal(tempDir(), 'C:\\fake\\temp');
  setTempDir(null);
  assert.equal(tempDir(), os.tmpdir());
  setTempDir(original);
});

test('resolveDataDir：显式指定最优先，macOS 用系统标准位置，其余平台用 exe 同级', () => {
  const win = { platform: 'win32', exeDir: 'C:\\portable\\CC Skill', systemUserData: 'C:\\Users\\x\\AppData\\Roaming\\CC Skill' };
  assert.equal(resolveDataDir(win), win.exeDir, 'Windows 保持便携语义');
  assert.equal(resolveDataDir({ ...win, platform: 'linux' }), win.exeDir, 'Linux 同样与可执行文件同级');
  assert.equal(resolveDataDir({ ...win, override: 'C:\\isolated' }), 'C:\\isolated', 'CC_SKILL_DATA_DIR 永远最优先');

  const mac = { platform: 'darwin', exeDir: '/Applications/CC Skill.app/Contents/MacOS', systemUserData: '/Users/x/Library/Application Support/CC Skill' };
  assert.equal(resolveDataDir(mac), mac.systemUserData, 'macOS 不能写进 .app 包内');
  assert.equal(resolveDataDir({ ...mac, override: '/tmp/isolated' }), '/tmp/isolated');
});

test('sweepStaleTempDirs 只删「过期 + 属于本应用」的临时项', () => {
  const dir = tmpDir('cc-skill-sweep-');
  const original = tempDir();
  setTempDir(dir);
  const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
  const make = (name, { age, isFile } = {}) => {
    const p = path.join(dir, name);
    if (isFile) fs.writeFileSync(p, 'x', 'utf8');
    else fs.mkdirSync(p);
    if (age) fs.utimesSync(p, twoHoursAgo, twoHoursAgo);
    return p;
  };
  try {
    const staleDir = make('cc-skill-import-1789528818085', { age: true });
    const staleFile = make('cc-skill-restore-1789528818085.zip', { age: true, isFile: true });
    const staleSync = make('cc-skill-sync-1789528818085', { age: true });
    const freshDir = make('cc-skill-import-1789533600441');
    const foreign = make('some-other-app-dir', { age: true });
    // 只按前缀匹配会误删这些：名字像但不是应用生成的
    const lookalikes = ['cc-skill-restore-test', 'cc-skill-import-backup', 'cc-skill-restore-abc', 'cc-skill-import-1.old'].map((n) => make(n, { age: true }));

    assert.equal(sweepStaleTempDirs(), 3, '应删掉 3 项过期的、名字精确匹配的目录/文件');
    assert.ok(!fs.existsSync(staleDir));
    assert.ok(!fs.existsSync(staleFile));
    assert.ok(!fs.existsSync(staleSync));
    assert.ok(fs.existsSync(freshDir), '没过期的不该删（可能正在用）');
    assert.ok(fs.existsSync(foreign), '不是本应用的目录不该碰');
    for (const p of lookalikes) assert.ok(fs.existsSync(p), `名字只是相似，不该删: ${path.basename(p)}`);
  } finally {
    setTempDir(original);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sweepStaleTempDirs 在临时目录不存在时安静返回', () => {
  const original = tempDir();
  setTempDir(path.join(os.tmpdir(), 'cc-skill-不存在的目录-' + Date.now()));
  try {
    assert.equal(sweepStaleTempDirs(), 0);
  } finally {
    setTempDir(original);
  }
});

// ------------------------------ 删链接：绝不动唯一副本 ------------------------------
// 真机踩过：卸载一条链接，`~/.agents/skills/<skill>/SKILL.md` 被一起删了，界面还报
// 「唯一副本保留」。根因是 fs.rmSync({recursive:true}) 在 Electron 44 的 Node 上会
// 顺着 junction 进到目标里去删。系统 Node 24.13 上同一个调用是安全的 ——
// 也就是说光靠「跑一遍看目标还在不在」测不出这个 bug，所以下面额外盯住「没调 rmSync」。
const { removePath } = require('../../src/paths');

function makeLinkFixture() {
  const root = tmpDir('cc-skill-rmlink-');
  const target = path.join(root, 'target');
  fs.mkdirSync(path.join(target, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(target, 'SKILL.md'), 'hello', 'utf8');
  fs.writeFileSync(path.join(target, 'sub', 'a.txt'), 'x', 'utf8');
  const link = path.join(root, 'link');
  fs.symlinkSync(target, link, LINK_TYPE);
  return { root, target, link };
}

test('removePath 摘掉链接，唯一副本的内容一个字都不能少', () => {
  const { root, target, link } = makeLinkFixture();
  try {
    removePath(link);
    assert.equal(fs.existsSync(link), false, '链接本身要被摘掉');
    assert.deepEqual(fs.readdirSync(target).sort(), ['SKILL.md', 'sub'], '唯一副本的内容必须完好');
    assert.equal(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'), 'hello');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('removePath 删链接时不碰 rmSync（它在 Electron 上会删光目标）', () => {
  const { root, target, link } = makeLinkFixture();
  const realRm = fs.rmSync;
  let rmCalled = false;
  fs.rmSync = (...args) => {
    rmCalled = true;
    return realRm(...args);
  };
  try {
    removePath(link);
  } finally {
    fs.rmSync = realRm;
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.equal(rmCalled, false, '删链接走了 rmSync —— 在打包后的应用里这会把唯一副本删空');
  assert.equal(fs.existsSync(target), false, '（夹具已随临时目录清理）');
});

test('removePath 对普通目录照旧递归删除', () => {
  const root = tmpDir('cc-skill-rmdir-');
  try {
    fs.mkdirSync(path.join(root, 'd', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'd', 'f.txt'), 'x', 'utf8');
    removePath(path.join(root, 'd'));
    assert.equal(fs.existsSync(path.join(root, 'd')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('removePath 对已经不存在的路径安静返回', () => {
  const root = tmpDir('cc-skill-rmgone-');
  try {
    removePath(path.join(root, 'nope'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
