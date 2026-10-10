// Agent 品牌标志：官方 SVG（离线打包在 renderer/agents/，不走外网 CDN），
// 按 id、名称、SKILL 目录名智能识别——用户自定义的 Agent 只要目录/名字沾上已知模式也能认出来。
// 认不出或暂时没有官方图标的回落到原彩色圆点。
// 素材来源：claude/openai/gemini/claw/copilot/opencode 取自 cc-switch 的 icons/extracted，
// qoder 取自 qoder.com 的 favIcon；zcode 等暂无可靠官方图的先回落圆点，找到后补一行即可。
const AGENT_LOGOS = {
  'claude-code': { src: 'agents/claude.svg' },
  codex: { src: 'agents/openai.svg', mono: true },
  opencode: { src: 'agents/opencode.svg', mono: true },
  gemini: { src: 'agents/gemini.svg' },
  openclaw: { src: 'agents/claw.svg' },
  copilot: { src: 'agents/copilot.svg', mono: true },
  qoder: { src: 'agents/qoder.svg' },
  // Z.ai 的 ZCode：官方仓库 zai-org/ZCode 的应用图标（仓库只提供 PNG，无 SVG）
  zcode: { src: 'agents/zcode.png' },
};

// 智能识别：id / 名称 / SKILL 目录路径任一命中即认领（自定义 Agent 靠目录名也能认出来）
function agentLogoKey(a) {
  const hay = [a && a.id, a && a.name, (a && a.dirs) || (a && a.dir) || ''].filter(Boolean).join(' ').toLowerCase();
  if (!hay.trim()) return null;
  if (/claude|anthropic/.test(hay)) return 'claude-code';
  if (/opencode/.test(hay)) return 'opencode';
  if (/codex|openai/.test(hay)) return 'codex';
  if (/gemini|google/.test(hay)) return 'gemini';
  if (/copilot/.test(hay)) return 'copilot';
  if (/qoder/.test(hay)) return 'qoder';
  if (/zcode/.test(hay)) return 'zcode';
  if (/openclaw|claw/.test(hay)) return 'openclaw';
  return null;
}

// 统一的标记渲染：认出品牌就上官方 Logo，认不出保留原彩色圆点。
// 外层沿用 .dot 类吃各处的尺寸规则，.agent-logo 负责去掉圆点底色并放大一点；
// 单色黑图标在深色主题下由 CSS 反色（见 .img-mono）。
// extraCls：调用方附带的布局类（如侧栏的 nav-dot），logo 与圆点回落都要带上
function agentMark(a, extraCls = '') {
  const extra = extraCls ? ' ' + extraCls : '';
  const key = agentLogoKey(a);
  const logo = key && AGENT_LOGOS[key];
  if (logo) {
    const cls = logo.mono ? ' class="img-mono"' : '';
    return `<span class="dot agent-logo${extra}"><img src="${logo.src}"${cls} alt="" loading="lazy" draggable="false"></span>`;
  }
  // 颜色进 style 属性，引号/尖括号必须洗掉
  const color = String((a && a.color) || '#9aa0a6').replace(/["'<>]/g, '');
  return `<span class="dot${extra}" style="background:${color}"></span>`;
}

// 显式挂到 window：app.js 跨文件使用，也让 eslint 认定「已使用」
window.agentMark = agentMark;
window.agentLogoKey = agentLogoKey;
window.AGENT_LOGOS = AGENT_LOGOS;
