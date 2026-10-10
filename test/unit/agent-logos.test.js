// Agent 品牌标志：智能识别与渲染回落（从 renderer/agent-logos.js 抽真实实现测）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'renderer', 'agent-logos.js'), 'utf8');

function extractFn(name) {
  const re = new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`);
  const m = src.match(re);
  assert.ok(m, `agent-logos.js 里找不到 ${name}`);
  return m[0];
}

const logoBlock = src.match(/const AGENT_LOGOS = \{[\s\S]*?\n\};/)[0];
const agentLogoKey = new Function(logoBlock + '\n' + extractFn('agentLogoKey') + '\nreturn agentLogoKey;')();
const agentMark = new Function(logoBlock + '\n' + extractFn('agentLogoKey') + '\n' + extractFn('agentMark') + '\nreturn agentMark;')();

test('注册表里的每个图标文件都真实存在', () => {
  const logos = new Function(logoBlock + '\nreturn AGENT_LOGOS;')();
  const dir = path.join(__dirname, '..', '..', 'renderer');
  for (const [key, logo] of Object.entries(logos)) {
    assert.ok(fs.existsSync(path.join(dir, logo.src)), `${key} 的图标文件缺失：${logo.src}`);
  }
});

test('智能识别：按 id / 名称 / SKILL 目录认出常见 Agent', () => {
  assert.equal(agentLogoKey({ id: 'claude-code', name: 'Claude Code' }), 'claude-code');
  assert.equal(agentLogoKey({ name: 'Codex' }), 'codex');
  assert.equal(agentLogoKey({ name: '自定义助手', dirs: ['~/.opencode/skills'] }), 'opencode');
  assert.equal(agentLogoKey({ name: 'Gemini CLI' }), 'gemini');
  assert.equal(agentLogoKey({ name: 'Qoder' }), 'qoder');
  assert.equal(agentLogoKey({ id: 'zcode', name: 'ZCode' }), 'zcode');
  assert.equal(agentLogoKey({ name: '完全自定义', dirs: ['~/my-skills'] }), null, '没有官方图标的回落 null');
});

test('agentMark：认出的渲染官方图标，认不出的回落彩色圆点', () => {
  const claude = agentMark({ id: 'claude-code', name: 'Claude Code', color: '#e07a4f' });
  assert.match(claude, /class="dot agent-logo"/);
  assert.match(claude, /<img src="agents\/claude\.svg"/);

  const codex = agentMark({ name: 'Codex', color: '#19b39a' });
  assert.match(codex, /<img src="agents\/openai\.svg" class="img-mono"/, '单色图标要标 img-mono 供深色主题反色');

  const unknown = agentMark({ name: '神秘 Agent', color: '#123456' });
  assert.ok(unknown.includes('background:#123456'), '未知 Agent 保留原色圆点');
  assert.ok(!unknown.includes('agent-logo'));
});

test('agentMark：extraCls 会同时带到 Logo 与圆点回落上（侧栏 nav-dot 用）', () => {
  const logo = agentMark({ name: 'Claude Code' }, 'nav-dot');
  assert.match(logo, /class="dot agent-logo nav-dot"/);
  const dot = agentMark({ name: '神秘 Agent', color: '#123456' }, 'nav-dot');
  assert.match(dot, /class="dot nav-dot"/);
});

test('agentMark：颜色里的引号/尖括号洗掉，不破坏 style 属性', () => {
  const evil = agentMark({ name: '未知', color: 'red"><script>x</script>' });
  assert.ok(!evil.includes('<script>'), '注入的标签必须被洗掉');
  // 脏内容只能以「洗过的纯文本」形态待在 style 值里，不能截断属性逃出去
  assert.match(evil, /^<span class="dot" style="background:[^"'<>]+"><\/span>$/);
});
