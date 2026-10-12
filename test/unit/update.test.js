// 在线更新逻辑：版本比较、平台/架构安装包挑选、GitHub URL 白名单、检测接口（mock 网络）
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setFetchImpl } = require('../../src/net');
const {
  parseVersion,
  compareVersions,
  pickAsset,
  parseAssets,
  checkUpdate,
  downloadUpdate,
  isGitHubReleaseUrl,
  buildUpdateBatch,
  installUpdate,
  parseChangelogEntries,
  entriesSince,
} = require('../../src/update');

afterEach(() => {
  // 还原成「没设置过」的默认实现，避免影响同文件后续用例
  setFetchImpl(null);
});

test('版本比较：v 前缀与纯数字等价，大小按三段比', () => {
  assert.deepEqual(parseVersion('v1.2.3'), [1, 2, 3]);
  assert.deepEqual(parseVersion('1.10.0'), [1, 10, 0]);
  assert.equal(parseVersion('不是版本'), null);
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('1.2.3', '1.10.0'), -1);
  assert.equal(compareVersions('2.0.0', '1.9.9'), 1);
  assert.equal(compareVersions('坏数据', '1.0.0'), 0, '解析不了就不给升级');
});

test('挑安装包：Windows 认 .exe，macOS 按 CPU 架构挑 dmg', () => {
  const assets = [
    { name: 'CC Skill-1.1.0-arm64.dmg', url: 'https://github.com/x/dmg-arm' },
    { name: 'CC Skill-1.1.0.dmg', url: 'https://github.com/x/dmg-x64' },
    { name: 'CC Skill.1.1.0.exe', url: 'https://github.com/x/exe' },
  ];
  assert.equal(pickAsset(assets, 'win32').url, 'https://github.com/x/exe');
  assert.equal(pickAsset(assets, 'darwin', 'arm64').url, 'https://github.com/x/dmg-arm');
  assert.equal(pickAsset(assets, 'darwin', 'x64').url, 'https://github.com/x/dmg-x64');
  assert.equal(pickAsset([], 'win32'), null);
});

test('解析 expanded_assets 页里的下载直链，&amp; 还原', () => {
  const html =
    '<a href="/kaamil95/cc-skill/releases/download/v1.2.0/CC.Skill.1.2.0.exe">exe</a>' +
    '<a href="/kaamil95/cc-skill/releases/download/v1.2.0/CC.Skill-1.2.0.dmg?a=1&amp;b=2">dmg</a>';
  const assets = parseAssets(html);
  assert.equal(assets.length, 2);
  assert.equal(assets[0].name, 'CC.Skill.1.2.0.exe');
  assert.equal(assets[0].url, 'https://github.com/kaamil95/cc-skill/releases/download/v1.2.0/CC.Skill.1.2.0.exe');
  assert.ok(assets[1].url.includes('a=1&b=2'), '&amp; 应还原成 &');
});

test('checkUpdate 主通道：latest.json 清单（Tauri updater 同款模式，不碰 api.github.com）', async () => {
  const calls = [];
  setFetchImpl(async (url) => {
    calls.push(String(url));
    assert.ok(String(url).endsWith('/releases/latest/download/latest.json'), '主通道必须请求清单端点');
    return {
      ok: true,
      status: 200,
      url: String(url),
      text: async () =>
        JSON.stringify({
          version: '1.2.0',
          notes: '修复了若干问题',
          platforms: {
            win32: 'https://github.com/kaamil95/cc-skill/releases/download/v1.2.0/CC.Skill.Setup.1.2.0.exe',
            'darwin-arm64': 'https://github.com/kaamil95/cc-skill/releases/download/v1.2.0/CC.Skill-1.2.0-arm64.dmg',
          },
        }),
    };
  });

  const newer = await checkUpdate({ currentVersion: '1.0.0', platform: 'win32' });
  assert.equal(newer.ok, true);
  assert.equal(newer.source, 'manifest');
  assert.equal(newer.updateAvailable, true);
  assert.equal(newer.latestVersion, '1.2.0');
  assert.equal(newer.asset.name, 'CC.Skill.Setup.1.2.0.exe');
  assert.equal(newer.htmlUrl, 'https://github.com/kaamil95/cc-skill/releases/tag/v1.2.0');

  const mac = await checkUpdate({ currentVersion: '1.0.0', platform: 'darwin', arch: 'arm64' });
  assert.match(mac.asset.url, /darwin-arm64|arm64\.dmg/);

  const same = await checkUpdate({ currentVersion: '1.2.0', platform: 'win32' });
  assert.equal(same.updateAvailable, false);
});

test('checkUpdate 回落：旧版 Release 没有 latest.json 时解析网页（不碰 api.github.com）', async () => {
  const calls = [];
  setFetchImpl(async (url) => {
    calls.push(String(url));
    if (String(url).endsWith('/releases/latest/download/latest.json')) {
      return { ok: false, status: 404, url: String(url), text: async () => 'Not Found' };
    }
    if (String(url).endsWith('/releases/latest')) {
      // Electron net.fetch 的 res.url 不可靠：即使为空，也要能从 HTML 里的 tag 链接拿版本号
      return {
        ok: true,
        status: 200,
        url: '',
        text: async () =>
          '<link rel="canonical" href="https://github.com/kaamil95/cc-skill/releases/tag/v1.2.0">' +
          '<a href="/kaamil95/cc-skill/releases/download/v1.2.0/CC.Skill.1.2.0.exe">exe</a>',
      };
    }
    return {
      ok: true,
      status: 200,
      url: String(url),
      text: async () => '<a href="/kaamil95/cc-skill/releases/download/v1.2.0/CC.Skill.1.2.0.exe">exe</a>',
    };
  });

  const r = await checkUpdate({ currentVersion: '1.0.0', platform: 'win32' });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'web');
  assert.equal(r.latestVersion, '1.2.0');
  assert.equal(r.updateAvailable, true);
  assert.equal(r.asset.name, 'CC.Skill.1.2.0.exe');
  assert.ok(
    calls.every((u) => !u.includes('api.github.com')),
    '不得请求 api.github.com（匿名额度会 403）'
  );
});

test('checkUpdate：网络层错误原样抛出，不误回落', async () => {
  setFetchImpl(async () => {
    throw new Error('fetch failed');
  });
  await assert.rejects(() => checkUpdate({ currentVersion: '1.0.0' }), /fetch failed/);
});

test('下载 URL 只放行 GitHub 发行域名', () => {
  assert.equal(isGitHubReleaseUrl('https://github.com/a/b/releases/download/v1/x.exe'), true);
  assert.equal(isGitHubReleaseUrl('https://objects.githubusercontent.com/x'), true);
  assert.equal(isGitHubReleaseUrl('https://evil.example.com/x.exe'), false);
  assert.equal(isGitHubReleaseUrl('http://github.com/a/b'), false);
  assert.equal(isGitHubReleaseUrl('not a url'), false);
});

test('downloadUpdate：非 GitHub 直接拒绝，不下文件', async () => {
  setFetchImpl(async () => {
    throw new Error('不该发生网络请求');
  });
  const r = await downloadUpdate({ url: 'https://evil.example.com/x.exe', version: '1.2.0' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid-url');
});

test('buildUpdateBatch：等应用退出 → 静默重装 → 自动重启，三步齐全', () => {
  const bat = buildUpdateBatch({ installerPath: String.raw`C:\Temp\cc-skill-1.0.2.exe`, appExe: String.raw`C:\Program Files\CC Skill\CC Skill.exe` });
  const lines = bat.split('\r\n');
  assert.match(lines[1], /ping -n 3/, '要先等应用退出');
  assert.match(lines[2], /"C:\\Temp\\cc-skill-1\.0\.2\.exe" \/S/, '安装器必须带 /S 静默参数');
  assert.match(lines[3], /start "" "C:\\Program Files\\CC Skill\\CC Skill\.exe"/, '装完要自动重启应用');
});

test('installUpdate：开发模式与非法路径直接拒绝，不执行任何东西', async () => {
  // 非 Windows 平台在第一道门就被拦下（静默升级只支持 NSIS），期望值跟着平台走
  const win = process.platform === 'win32';
  assert.equal(
    (await installUpdate({ installerPath: String.raw`C:\Temp\cc-skill-1.0.2.exe`, appExe: 'x', isPackaged: false })).reason,
    win ? 'dev-mode' : 'unsupported'
  );
  assert.equal(
    (await installUpdate({ installerPath: String.raw`C:\evil\tool.exe`, appExe: 'x', isPackaged: true })).reason,
    win ? 'invalid-path' : 'unsupported'
  );
});

test('parseChangelogEntries：中文节解析成版本条目，英文节与空节不进结果', () => {
  const md = [
    '# Changelog',
    '',
    '## [1.0.3] - 2026-10-12',
    '',
    '### 变更',
    '- **应用内更新改为静默升级**：点「立即安装」即可',
    '',
    '### English',
    '',
    '#### Changed',
    '- **In-app updates are now silent**: click "Install now"',
    '',
    '## [1.0.2] - 2026-10-12',
    '',
    '### 修复',
    '- **机器认领会合并云端记录**：两条记录合成一条',
    '- **机器身份不再丢失**：落盘前强制补齐 machineId',
    '',
    '## [1.0.1] - 2026-10-10',
    '',
    '### 新增',
    '- **应用内在线更新**：无需 Token',
  ].join('\n');
  const entries = parseChangelogEntries(md);
  assert.deepEqual(
    entries.map((e) => e.version),
    ['1.0.3', '1.0.2', '1.0.1'],
    '新到旧，1.0.3 的 English 节不截断后面的版本'
  );
  assert.equal(entries[0].items.length, 1);
  assert.equal(entries[0].items[0].type, 'improve');
  assert.equal(entries[1].items[0].type, 'fix');
  assert.equal(entries[2].items[0].type, 'new');
});

test('entriesSince：只取 (seen, current] 区间；没有 seen 不弹', () => {
  const entries = [
    { version: '1.0.3', items: [{ type: 'improve', text: 'x' }] },
    { version: '1.0.2', items: [{ type: 'fix', text: 'y' }] },
    { version: '1.0.1', items: [{ type: 'new', text: 'z' }] },
  ];
  assert.deepEqual(entriesSince(entries, null, '1.0.3'), [], '首次安装不弹');
  assert.deepEqual(
    entriesSince(entries, '1.0.1', '1.0.3').map((e) => e.version),
    ['1.0.3', '1.0.2'],
    '(seen, current] 全弹'
  );
  assert.deepEqual(entriesSince(entries, '1.0.3', '1.0.3'), [], '刚看过就不弹');
  assert.deepEqual(entriesSince(entries, '2.0.0', '1.0.3'), [], '降级不往回弹');
});
