// 界面偏好的归一化——纯函数
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeUi,
  OVERLAY_DEFAULTS,
  THEMES,
  THEME_BG,
  themeBg,
  normalizeProxy,
  proxyToSessionConfig,
  proxyCredentials,
  normalizeMarket,
  redactProxyUrl,
  normalizeMachineName,
  normalizeMachineNames,
  normalizeCollections,
  normalizeCollectionScope,
  parseConfigPayload,
} = require('../../src/config');

test('ui 缺失时给全套默认值', () => {
  for (const input of [null, undefined, {}, { lang: 'xx' }]) {
    const ui = normalizeUi(input);
    assert.equal(ui.lang, 'auto', `输入 ${JSON.stringify(input)}`);
    assert.equal(ui.theme, 'light');
    assert.equal(ui.accent, 'auto');
    assert.equal(ui.overlayBlur, OVERLAY_DEFAULTS.blur);
    assert.equal(ui.overlayDim, OVERLAY_DEFAULTS.dim);
  }
});

test('合法的语言与遮罩值原样保留', () => {
  assert.deepEqual(normalizeUi({ lang: 'en', overlayBlur: 8, overlayDim: 0.5 }), {
    lang: 'en',
    theme: 'light',
    accent: 'auto',
    overlayBlur: 8,
    overlayDim: 0.5,
  });
});

test('越界的遮罩值被夹到范围内（手改 config.json 不该让界面失控）', () => {
  assert.equal(normalizeUi({ overlayBlur: -10 }).overlayBlur, 0);
  assert.equal(normalizeUi({ overlayBlur: 999 }).overlayBlur, 40);
  assert.equal(normalizeUi({ overlayDim: -1 }).overlayDim, 0);
  assert.equal(normalizeUi({ overlayDim: 5 }).overlayDim, 0.8);
});

test('非数字的遮罩值回落到默认值', () => {
  assert.equal(normalizeUi({ overlayBlur: 'abc' }).overlayBlur, OVERLAY_DEFAULTS.blur);
  assert.equal(normalizeUi({ overlayDim: null }).overlayDim, OVERLAY_DEFAULTS.dim);
  assert.equal(normalizeUi({ overlayDim: NaN }).overlayDim, OVERLAY_DEFAULTS.dim);
});

test('数字字符串按数字处理（config.json 手写常见）', () => {
  assert.equal(normalizeUi({ overlayBlur: '12' }).overlayBlur, 12);
  assert.equal(normalizeUi({ overlayDim: '0.6' }).overlayDim, 0.6);
});

test('边界值 0 不会被当成缺失', () => {
  assert.equal(normalizeUi({ overlayBlur: 0 }).overlayBlur, 0);
  assert.equal(normalizeUi({ overlayDim: 0 }).overlayDim, 0);
});

test('主题只认清单里的 id，其余回落到 light', () => {
  assert.equal(normalizeUi({ theme: 'dark' }).theme, 'dark');
  assert.equal(normalizeUi({ theme: 'sepia' }).theme, 'sepia');
  for (const bad of ['DARK', 'neon', '', null, 42, {}]) {
    assert.equal(normalizeUi({ theme: bad }).theme, 'light', `输入 ${JSON.stringify(bad)}`);
  }
});

test('强调色只接受 6 位十六进制，其余一律 auto（用主题自带的）', () => {
  assert.equal(normalizeUi({ accent: '#0A84FF' }).accent, '#0a84ff'); // 统一小写，便于比对
  assert.equal(normalizeUi({ accent: '  #34c759  ' }).accent, '#34c759');
  for (const bad of ['auto', 'red', '#fff', '#12345', 'javascript:alert(1)', null, 7]) {
    assert.equal(normalizeUi({ accent: bad }).accent, 'auto', `输入 ${JSON.stringify(bad)}`);
  }
});

test('每个主题都有窗口底色（主进程要在渲染层之前铺对底色）', () => {
  for (const t of THEMES) {
    assert.match(THEME_BG[t], /^#[0-9a-f]{6}$/i, `主题 ${t} 缺底色`);
    assert.equal(themeBg(t), THEME_BG[t]);
  }
  // 未知主题不能让窗口底色变成 undefined
  assert.equal(themeBg('nope'), THEME_BG.light);
  assert.equal(themeBg(undefined), THEME_BG.light);
});

// ------------------------------ 代理 ----------------------------------------
test('代理默认跟随系统，非法值一律回落', () => {
  for (const bad of [null, undefined, {}, { mode: 'socks' }, { mode: 'MANUAL' }]) {
    assert.equal(normalizeProxy(bad).mode, 'system', JSON.stringify(bad));
  }
  assert.equal(normalizeProxy({ mode: 'manual' }).url, '');
});

test('代理地址只接受 http/https/socks，其余清空（免得把垃圾写进 session）', () => {
  assert.equal(normalizeProxy({ mode: 'manual', url: '  http://127.0.0.1:7890 ' }).url, 'http://127.0.0.1:7890');
  assert.equal(normalizeProxy({ mode: 'manual', url: 'socks5://127.0.0.1:1080' }).url, 'socks5://127.0.0.1:1080');
  assert.equal(normalizeProxy({ mode: 'manual', url: '127.0.0.1:7890' }).url, '', '缺 scheme 不算合法地址');
  assert.equal(normalizeProxy({ mode: 'manual', url: 'file:///etc/passwd' }).url, '');
});

test('代理 → session 配置：三种模式的映射，bypass 一律补 <local>', () => {
  assert.deepEqual(proxyToSessionConfig({ mode: 'system' }), { mode: 'system' });
  assert.deepEqual(proxyToSessionConfig({ mode: 'direct' }), { mode: 'direct' });
  assert.deepEqual(proxyToSessionConfig({ mode: 'manual', url: 'http://127.0.0.1:7890' }), {
    mode: 'fixed_servers',
    proxyRules: 'http://127.0.0.1:7890',
    proxyBypassRules: '<local>',
  });
  assert.deepEqual(proxyToSessionConfig({ mode: 'manual', url: 'http://p:1', bypass: '*.internal, 10.0.0.0/8' }), {
    mode: 'fixed_servers',
    proxyRules: 'http://p:1',
    // Chromium 的 bypass 列表是不带空格的逗号分隔
    proxyBypassRules: '*.internal, 10.0.0.0/8,<local>',
  });
  // 手动但没填地址：宁可跟随系统，也不要让网络整个断掉
  assert.deepEqual(proxyToSessionConfig({ mode: 'manual', url: '' }), { mode: 'system' });
});

test('代理鉴权凭据从 URL 里取，Chromium 不会自己用 user:pass', () => {
  assert.deepEqual(proxyCredentials({ mode: 'manual', url: 'http://u:p%40w@127.0.0.1:7890' }), { username: 'u', password: 'p@w' });
  assert.equal(proxyCredentials({ mode: 'manual', url: 'http://127.0.0.1:7890' }), null);
  assert.equal(proxyCredentials({ mode: 'system', url: 'http://u:p@127.0.0.1:7890' }), null);
});

test('代理地址落日志前抹掉凭据（明文密码不该写进 cc-skill.log）', () => {
  assert.match(redactProxyUrl('http://user:secret@127.0.0.1:7890'), /^http:\/\/\*\*\*@127\.0\.0\.1:7890/);
  assert.equal(redactProxyUrl('http://127.0.0.1:7890'), 'http://127.0.0.1:7890');
  // 传进来的可能是一整条错误信息而不是纯 URL：按字符串粗暴抹，宁可多抹
  assert.equal(redactProxyUrl('连接失败：http://u:p@h:1 不可用'), '连接失败：http://***@h:1 不可用');
  assert.equal(redactProxyUrl(''), '');
});

// ------------------------------ 市场 ----------------------------------------
test('市场配置：索引地址必须是 http(s)，token 去空白', () => {
  assert.deepEqual(normalizeMarket(null), { indexUrl: '', token: '' });
  assert.equal(normalizeMarket({ indexUrl: 'https://e.test/i.json' }).indexUrl, 'https://e.test/i.json');
  assert.equal(normalizeMarket({ indexUrl: 'file:///tmp/i.json' }).indexUrl, '');
  assert.equal(normalizeMarket({ token: '  ghp_x  ' }).token, 'ghp_x');
});

// ------------------------------ 机器名 / 别名 --------------------------------
test('机器名去掉控制字符与换行，压掉连续空白，限长 40', () => {
  assert.equal(normalizeMachineName(null), '');
  assert.equal(normalizeMachineName(123), '');
  assert.equal(normalizeMachineName('   '), '');
  // 换行与制表符不能漏进界面/JSON；压成一个空格
  assert.equal(normalizeMachineName('我的\n电脑\tA'), '我的 电脑 A');
  assert.equal(normalizeMachineName('  我的   电脑  '), '我的 电脑');
  assert.equal(normalizeMachineName('x'.repeat(60)).length, 40);
  // 非 ASCII 一律保留：中文、emoji 都该原样留下
  assert.equal(normalizeMachineName('🖥 开发机'), '🖥 开发机');
  // 截断必须按码点：按 UTF-16 码元 slice 会把末尾的 emoji 切成半个代理对，写进配置就是乱码
  assert.equal([...normalizeMachineName('🖥'.repeat(30))].length, 30, '30 个 emoji = 60 码元，不该被截成 40 码元');
  assert.equal([...normalizeMachineName('🖥'.repeat(50))].length, 40, '超长按码点截到 40');
  // 零宽 / bidi 格式字符直接移除（不是换成空白）：它们不可见，能把名字伪装成
  // 完全不同的字符串——删除确认框里写着「删除 A」实际删的是 B 就是这类字符干的
  assert.equal(normalizeMachineName('a​b'), 'ab');
});

test('别名表丢掉非法 id 与空名字', () => {
  assert.deepEqual(normalizeMachineNames(null), {});
  assert.deepEqual(normalizeMachineNames('nope'), {});
  assert.deepEqual(normalizeMachineNames({ good: ' A ', '../evil': 'B', 'has space': 'C', empty: '   ', bad: 42 }), { good: 'A' });
});

// ------------------------------ 配置文件 payload -----------------------------
test('parseConfigPayload 拒绝非 JSON 与非本应用的配置文件', () => {
  assert.equal(parseConfigPayload('{oops').reason, 'invalid-json');
  assert.equal(parseConfigPayload(null).reason, 'not-config');
  assert.equal(parseConfigPayload({ kind: 'market', config: { agents: [] } }).reason, 'not-config');
  // kind 对了但 agents 不是数组，同样不算
  assert.equal(parseConfigPayload({ kind: 'config', config: { agents: 'oops' } }).reason, 'not-config');
});

test('parseConfigPayload 给出确认框要用的摘要', () => {
  const payload = {
    kind: 'config',
    exportedAt: '2026-09-30T00:00:00.000Z',
    config: {
      agents: [
        { id: 'a', dirs: [] },
        { id: 'b', dirs: [] },
      ],
      projects: [{ id: 'p', dir: '~/x' }, { nope: true }],
      ui: { lang: 'en' },
      webdav: { url: 'https://dav.test', password: 'p' },
      machineName: ' 台式机 ',
    },
  };
  const r = parseConfigPayload(JSON.stringify(payload));
  assert.equal(r.ok, true);
  assert.deepEqual(r.summary, {
    agents: 2,
    projects: 1,
    lang: 'en',
    webdav: true,
    webdavUrl: 'https://dav.test',
    password: true,
    machineName: '台式机',
    exportedAt: '2026-09-30T00:00:00.000Z',
  });
});

// ------------------------------ 虚拟分组归一化 ------------------------------
test('normalizeCollections：形状收敛（脏条目整条丢、dir 统一 ~ 形式、item 去重）', () => {
  // toTilde 只认真实家目录前缀，测试里的目录就用 homedir 拼出来
  const os = require('os');
  const homeSkills = require('path').join(os.homedir(), '.zcode', 'skills');
  const out = normalizeCollections([
    null,
    {
      id: 'ok',
      name: ' 企微 ',
      items: [
        { dir: homeSkills, folder: 'doc' },
        { dir: homeSkills.replaceAll('\\', '/') + '/', folder: 'doc' },
      ],
    },
    { id: 'ok', name: '重复 id 丢弃', items: [] },
    { name: '没有 id 的丢弃', items: [] },
    { id: 'no-name', name: '', items: [] },
    {
      id: 'bad-folder',
      name: 'X',
      items: [
        { dir: '~/a', folder: '../etc' },
        { dir: '~/a', folder: 'a\\b' },
      ],
    },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'ok');
  assert.equal(out[0].name, '企微');
  assert.deepEqual(out[0].items, [{ dir: '~/.zcode/skills', folder: 'doc' }]);
});

test('normalizeCollections：同名分组（大小写不敏感）只留第一条', () => {
  const out = normalizeCollections([
    { id: 'a', name: 'Work', items: [] },
    { id: 'b', name: 'work', items: [] },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'a');
});

test('normalizeCollections：空分组保留（刚建好还没收 SKILL 是合法状态）', () => {
  const out = normalizeCollections([{ id: 'a', name: '空', items: [] }]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].items, []);
});

test('normalizeCollections：非数组输入一律空表（旧版 config 缺字段不炸）', () => {
  for (const input of [undefined, null, {}, 'x']) assert.deepEqual(normalizeCollections(input), []);
});

// ------------------------------ 分组作用域 ------------------------------
test('normalizeCollections：旧数据没有 scope 一律迁移为 global', () => {
  const out = normalizeCollections([{ id: 'a', name: '旧分组', items: [] }]);
  assert.equal(out[0].scope, 'global');
});

test('normalizeCollections：合法 project scope 保留，非法值回落 global', () => {
  const out = normalizeCollections([
    { id: 'a', name: '项目组', scope: 'project:proj-1', items: [] },
    { id: 'b', name: '坏作用域', scope: 'project:', items: [] },
    { id: 'c', name: '乱写', scope: 42, items: [] },
  ]);
  assert.equal(out[0].scope, 'project:proj-1');
  assert.equal(out[1].scope, 'global');
  assert.equal(out[2].scope, 'global');
});

test('normalizeCollectionScope 直接分支', () => {
  assert.equal(normalizeCollectionScope('global'), 'global');
  assert.equal(normalizeCollectionScope('project:abc'), 'project:abc');
  assert.equal(normalizeCollectionScope(''), 'global');
  assert.equal(normalizeCollectionScope(null), 'global');
});

test('normalizeCollections：同名分组跨作用域允许共存，同作用域内仍去重', () => {
  const out = normalizeCollections([
    { id: 'a', name: 'Work', scope: 'global', items: [] },
    { id: 'b', name: 'work', scope: 'project:p1', items: [] },
    { id: 'c', name: 'WORK', scope: 'project:p1', items: [] },
  ]);
  assert.deepEqual(
    out.map((c) => [c.id, c.scope]),
    [
      ['a', 'global'],
      ['b', 'project:p1'],
    ]
  );
});

test('normalizeMachineName 去掉零宽与 bidi 控制符（分组名伪装防线）', () => {
  assert.equal(normalizeMachineName('企\u200b微\u202e组'), '企微组');
  assert.equal(normalizeMachineName('正常 名字'), '正常 名字');
});
