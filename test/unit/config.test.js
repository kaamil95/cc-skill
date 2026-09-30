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
  // 零宽字符不是控制字符，不该被当空白吃掉
  assert.equal(normalizeMachineName('a​b'), 'a​b');
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
    password: true,
    machineName: '台式机',
    exportedAt: '2026-09-30T00:00:00.000Z',
  });
});
