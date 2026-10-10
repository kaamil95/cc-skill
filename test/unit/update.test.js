// 在线更新逻辑：版本比较、平台/架构安装包挑选、GitHub URL 白名单、检测接口（mock 网络）
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setFetchImpl } = require('../../src/net');
const { parseVersion, compareVersions, pickAsset, parseAssets, checkUpdate, downloadUpdate, isGitHubReleaseUrl } = require('../../src/update');

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
