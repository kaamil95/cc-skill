// 启动兜底。在 app.js **之前**加载，覆盖的是「连 try/catch 都进不去」的情况：
// app.js 语法错误、i18n.js 挂掉、渲染进程在初始化前就抛异常。
// 那些情况下界面只剩 index.html 的静态空壳，主区一片空白，用户无路可走——
// 这里保证至少有一个「重新加载」按钮。
(function () {
  const TIMEOUT_MS = 6000;
  const tr = (s) => (typeof t === 'function' ? t(s) : s);

  setTimeout(() => {
    // __appBooted 在 app.js 的 IIFE 一开始就置位，__appReady 是初始化跑完（成功或已渲染错误态）。
    // 只认前者会误报：首次扫描超过 6 秒时界面其实正常，只是还没画完
    if (window.__appBooted || window.__appReady) return;
    const grid = document.getElementById('grid');
    if (!grid || grid.children.length) return; // 已经有内容，别插一脚

    const box = document.createElement('div');
    box.className = 'empty';
    const text = document.createElement('div');
    text.textContent = tr('界面初始化失败，请点击重新加载');
    box.appendChild(text);

    const actions = document.createElement('div');
    actions.className = 'dash-actions';
    actions.style.justifyContent = 'center';
    const btn = document.createElement('button');
    btn.className = 'btn primary';
    btn.textContent = tr('重新加载');
    btn.addEventListener('click', () => location.reload());
    actions.appendChild(btn);

    grid.appendChild(box);
    grid.appendChild(actions);
  }, TIMEOUT_MS);
})();
