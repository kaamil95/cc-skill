// 导航与引用链接判定。刻意不依赖 electron —— 纯函数，能被 node --test 直接调用。
//
// 存在的理由：渲染层把 SKILL.md 里的相对链接原样渲染成 <a href="references/x.md">，
// 而页面基准是 renderer/index.html。点一下就会把整个窗口导航到
// renderer/references/x.md，目标不存在时窗口只剩白屏 —— 连自绘标题栏都随 DOM 消失，
// 用户没有任何可操作的入口。所以「该不该放行」必须有一个唯一判定，由主进程执行。
const path = require('path');
const fs = require('fs');
const { fileURLToPath } = require('url');
const { IS_WIN } = require('./paths');

// 可内嵌预览的文本类型；其余类型交给系统默认程序
const TEXT_EXT = new Set(['.md', '.markdown', '.txt']);
// 允许转交系统处理的 scheme。其余（javascript: / data: / vbscript: …）一律拦截
const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/** 去掉 ?query / #hash：它们只对页面有意义，对文件路径是噪声 */
const stripTail = (s) =>
  String(s || '')
    .split('#')[0]
    .split('?')[0];

const decodeSafe = (s) => {
  try {
    return decodeURIComponent(s);
  } catch (_) {
    return s; // 含非法转义序列时按原文处理，别把整个链接判成坏链
  }
};

/** 路径比对用：Windows 大小写不敏感，且末尾分隔符无关 */
function normPath(p) {
  const s = path.resolve(String(p || '')).replace(/[\\/]+$/, '');
  return IS_WIN ? s.toLowerCase() : s;
}

/** abs 是否落在 base 目录内（含 base 自身） */
function insideDir(base, abs) {
  const b = normPath(base);
  if (!b) return false;
  const a = normPath(abs);
  return a === b || a.startsWith(b + path.sep) || a.startsWith(b + '/');
}

/** appUrl（file:// 形式）对应的磁盘路径；解析不出来返回 '' */
function appPathOf(appUrl) {
  try {
    return appUrl ? fileURLToPath(new URL(appUrl)) : '';
  } catch (_) {
    return '';
  }
}

/**
 * 目标 URL 该怎么处理。返回值就是主进程要执行的动作：
 *   { action: 'allow' }                 放行——本应用自己的页面
 *   { action: 'openExternal', url }      交给系统浏览器
 *   { action: 'openLocal', path }        用系统默认程序打开本地文件
 *   { action: 'block', reason }          拦截（javascript: / data: / 无法解析等）
 */
function classifyNavigation(targetUrl, { appUrl } = {}) {
  const url = String(targetUrl || '').trim();
  if (!url) return { action: 'block', reason: 'empty' };
  // 同文档（含纯 #锚点）放行
  if (appUrl && stripTail(url) === stripTail(appUrl)) return { action: 'allow' };

  let u;
  try {
    u = new URL(url);
  } catch (_) {
    return { action: 'block', reason: 'invalid' };
  }
  if (EXTERNAL_SCHEMES.has(u.protocol)) return { action: 'openExternal', url: u.href };

  if (u.protocol === 'file:') {
    let p;
    try {
      p = fileURLToPath(u);
    } catch (_) {
      return { action: 'block', reason: 'invalid' };
    }
    const ap = appPathOf(appUrl);
    if (ap && normPath(p) === normPath(ap)) return { action: 'allow' };
    return { action: 'openLocal', path: p };
  }
  return { action: 'block', reason: u.protocol.replace(':', '') || 'unknown' };
}

/**
 * 把 markdown 里的 href 解析成真实文件。相对路径一律相对 baseDir（SKILL 所在目录），
 * **绝不相对页面** —— 那正是白屏的成因。
 * 成功：{ ok:true, kind:'text'|'other'|'external'|'anchor', path?, ext?, url?, anchor? }
 * 失败：{ ok:false, reason: 'empty'|'scheme'|'outside'|'missing'|'directory', path? }
 */
function resolveRef(baseDir, href) {
  const raw = String(href == null ? '' : href).trim();
  if (!raw) return { ok: false, reason: 'empty' };
  // 纯锚点：留在当前文档内，不涉及文件系统
  if (raw.startsWith('#')) return { ok: true, kind: 'anchor', anchor: raw.slice(1) };

  // 外链必须用原文：?query 与 #anchor 是 URL 的组成部分，先 stripTail 会把
  // https://x/a?b=1#c 截成 https://x/a，打开的是另一个地址
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw);
  if (scheme && scheme[1].length > 1) {
    const s = scheme[1].toLowerCase() + ':';
    return EXTERNAL_SCHEMES.has(s) ? { ok: true, kind: 'external', url: raw } : { ok: false, reason: 'scheme' };
  }

  // 文件路径才需要剥掉 ?query / #hash —— 它们对路径是噪声
  const cleaned = decodeSafe(stripTail(raw)).trim();
  if (!cleaned) return { ok: false, reason: 'empty' };

  // 绝对路径、盘符相对路径（C:foo）、UNC 一律拒绝：SKILL 内的引用只允许指向自己目录
  if (path.isAbsolute(cleaned) || /^[a-z]:/i.test(cleaned)) return { ok: false, reason: 'outside' };
  if (!baseDir) return { ok: false, reason: 'outside' };

  const base = path.resolve(String(baseDir));
  const abs = path.resolve(base, cleaned.replace(/\\/g, '/'));
  if (!insideDir(base, abs)) return { ok: false, reason: 'outside' };

  let st;
  try {
    st = fs.statSync(abs);
  } catch (_) {
    return { ok: false, reason: 'missing', path: abs };
  }
  if (st.isDirectory()) return { ok: false, reason: 'directory', path: abs };

  const ext = path.extname(abs).toLowerCase();
  return { ok: true, kind: TEXT_EXT.has(ext) ? 'text' : 'other', path: abs, ext };
}

module.exports = { classifyNavigation, resolveRef, insideDir, TEXT_EXT };
