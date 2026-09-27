// theme.js — 主题与强调色。与 i18n.js 同构：启动时先用 localStorage 的缓存同步套一次，
// 免得闪一下默认配色；拿到 config.json 的权威值后再套一次（见 app.js 的 applyTheme）。
//
// 分工：四套配色的具体颜色在 styles.css 的 [data-theme='...'] 块里，这里只管
// 「往 DOM 上写什么」。强调色的派生（浅底/悬停/按下）交给 CSS 的 color-mix ——
// 用户改色只需要覆盖 --accent 一个变量，不必在 JS 里手算一串颜色。
(function () {
  const THEMES = ['light', 'dark', 'sepia', 'contrast'];
  const ACCENT_AUTO = 'auto';
  const ACCENTS = ['#0071e3', '#8b5cf6', '#0d9488', '#d97757', '#34c759', '#e5484d'];
  const CACHE_KEY = 'cc-skill-theme';
  const HEX_RE = /^#[0-9a-f]{6}$/i;

  const isTheme = (t) => THEMES.includes(t);
  const isHex = (a) => typeof a === 'string' && HEX_RE.test(a.trim());

  /**
   * 强调色 → 配套的前景色。CSS 用 color-mix 能算出深浅变化，但「这个色该配白字还是
   * 黑字」需要判断，只能在这里做。
   * 阈值取黑白对比度相等的那一点（L≈0.179）：比它亮用深字，否则用白字。
   * 取高了会出事——预设里的绿 #34c759 亮度 0.42，配白字只有 2.2:1，远低于可读的 4.5:1。
   */
  function deriveAccent(hex) {
    if (!isHex(hex)) return null;
    const accent = hex.trim().toLowerCase();
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(accent.slice(i, i + 2), 16));
    const lin = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    return { accent, onAccent: luminance > 0.179 ? '#1d1d1f' : '#ffffff' };
  }

  /** 把主题与强调色写到 DOM 上。accent 为 'auto'（或非法）时清掉覆盖，用主题自带的 */
  function apply(ui) {
    const theme = isTheme(ui && ui.theme) ? ui.theme : 'light';
    const el = document.documentElement;
    el.dataset.theme = theme;
    const derived = deriveAccent(ui && ui.accent);
    if (derived) {
      el.style.setProperty('--accent', derived.accent);
      el.style.setProperty('--on-accent', derived.onAccent);
    } else {
      // 必须 removeProperty 而不是写回默认值：主题自带的强调色在 CSS 里，
      // 内联值会盖掉它，深色主题就会被迫用浅色主题的蓝
      el.style.removeProperty('--accent');
      el.style.removeProperty('--on-accent');
    }
    return theme;
  }

  const normalize = (ui) => ({
    theme: isTheme(ui && ui.theme) ? ui.theme : 'light',
    accent: isHex(ui && ui.accent) ? ui.accent.trim().toLowerCase() : ACCENT_AUTO,
  });

  function cache(ui) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(normalize(ui)));
    } catch (_) {
      /* 存不进去只影响下次启动闪一下，不影响功能 */
    }
  }

  function readCache() {
    try {
      const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      return raw ? normalize(raw) : null;
    } catch (_) {
      return null;
    }
  }

  /** 启动时同步套用缓存（localStorage 是同步的，能在首帧前生效） */
  function applyCached() {
    const cached = readCache();
    if (cached) apply(cached);
  }

  window.theme = { THEMES, ACCENTS, ACCENT_AUTO, isTheme, isHex, deriveAccent, apply, applyCached, cache, readCache };

  // 在首帧之前套用上次的配色。这一步必须在这里发生：theme.js 在 <head> 里、
  // app.js 之前加载，等 app.js 拿到配置再套就已经闪过一帧默认配色了。
  applyCached();
})();
