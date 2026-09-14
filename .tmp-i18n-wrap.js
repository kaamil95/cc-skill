// app.js i18n 改造：拼接串 → tf()，剩余中文串 → t()，并导出键清单
const fs = require('fs');
const CJK = /[\u4e00-\u9fff]/;

let s = fs.readFileSync('renderer/app.js', 'utf8');

// ---- 1) 拼接/插值串显式转换（含变量，必须先行）----
const pairs = [
  // 主标题
  ["$('#main-title').textContent = a ? `${a.name} 的 SKILL` : '全部 SKILL';",
   "$('#main-title').textContent = a ? tf('{name} 的 SKILL', { name: a.name }) : t('全部 SKILL');"],
  ["$('#main-title').textContent = proj ? `${proj.name} · SKILL` : '项目 SKILL';",
   "$('#main-title').textContent = proj ? tf('{name} · SKILL', { name: proj.name }) : t('项目 SKILL');"],
  ["$('#main-title').textContent = '总览';", "$('#main-title').textContent = t('总览');"],
  // 侧栏脚注
  ["$('#sidebar-foot').innerHTML = `${state.view.length} 个 SKILL<br>${state.agents.reduce((n, a) => n + (a.dirs || []).length, 0)} 个 SKILL 目录 · ${state.projects.length} 个项目`;",
   "$('#sidebar-foot').innerHTML = tf('{gn} 个 SKILL · {dn} 个 SKILL 目录 · {pn} 个项目', { gn: state.view.length, dn: state.agents.reduce((n, a) => n + (a.dirs || []).length, 0), pn: state.projects.length });"],
  // dups 标签
  ["$('#dups-label').textContent = n ? `合并重复 (${n})` : '合并重复';",
   "$('#dups-label').textContent = n ? tf('合并重复 ({n})', { n }) : t('合并重复');"],
  // 主 hint
  ["$('#main-hint').textContent = `共 ${totalListed} 个 SKILL`;", "$('#main-hint').textContent = tf('共 {n} 个 SKILL', { n: totalListed });"],
  // 卡片描述缺失
  ["${esc(s.description) || '<span style=\"opacity:.55\">（无描述）</span>'}",
   "${esc(s.description) || '<span style=\"opacity:.55\">' + t('（无描述）') + '</span>'}"],
  // copy-src
  ["$('#copy-src').innerHTML =\n    `将安装 <b>${esc(s.name)}</b>（${s.type === 'folder' ? '整目录' : '单文件'}）` +\n    (fromProject ? ` <span class=\"chip proj-chip\">${esc(s.project.name)}</span>` : '');",
   "$('#copy-src').innerHTML =\n    tf(s.type === 'folder' ? '将安装 {name}（整目录）' : '将安装 {name}（单文件）', { name: '<b>' + esc(s.name) + '</b>' }) +\n    (fromProject ? ` <span class=\"chip proj-chip\">${esc(s.project.name)}</span>` : '');"],
  // merge 结果 toast
  ["  if (r.failed === 0) {\n    const parts = ['1 份唯一副本'];\n    if (r.linked) parts.push(r.linked + ' 个链接');\n    if (r.synced) parts.push(r.synced + ' 个项目同步');\n    toast(`已合并「${g.folder}」：${parts.join(' + ')} ✓`, 'ok');\n  } else {\n    toast(`「${g.folder}」合并未完成：${r.total - r.failed}/${r.total} 个副本处理成功，详见操作日志`, 'err');\n  }",
   "  if (r.failed === 0) {\n    const parts = [t('1 份唯一副本')];\n    if (r.linked) parts.push(tf('{n} 个链接', { n: r.linked }));\n    if (r.synced) parts.push(tf('{n} 个项目同步', { n: r.synced }));\n    toast(tf('已合并「{name}」：{parts} ✓', { name: g.folder, parts: parts.join(' + ') }), 'ok');\n  } else {\n    toast(tf('「{name}」合并未完成：{done}/{total} 个副本处理成功，详见操作日志', { name: g.folder, done: r.total - r.failed, total: r.total }), 'err');\n  }"],
  // 链接 hint（详情）
  ["    hint.textContent = `🔗 此条目是链接，唯一副本位于 ${shortPath(s.linkTarget || '')}，在这里编辑即修改唯一副本。`;",
   "    hint.textContent = tf('🔗 此条目是链接，唯一副本位于 {p}，在这里编辑即修改唯一副本。', { p: shortPath(s.linkTarget || '') });"],
  ["    hint.textContent = `🔗 此副本是唯一实体，另有 ${s.linkCount} 个 Agent 通过链接共用它；在这里更新，所有 Agent 即时生效。`;",
   "    hint.textContent = tf('🔗 此副本是唯一实体，另有 {n} 个 Agent 通过链接共用它；在这里更新，所有 Agent 即时生效。', { n: s.linkCount });"],
  // 链接行
  ["      <span class=\"link-tag ${l.dangling ? 'bad' : ''}\">${l.dangling ? '⚠ 失效' : '正常'}</span>",
   "      <span class=\"link-tag ${l.dangling ? 'bad' : ''}\">${l.dangling ? t('⚠ 失效') : t('正常')}</span>"],
  ["        <button class=\"btn sm act-link-open\">打开</button>\n        <button class=\"btn sm danger act-link-uninstall\">卸载</button>",
   "        <button class=\"btn sm act-link-open\">${t('打开')}</button>\n        <button class=\"btn sm danger act-link-uninstall\">${t('卸载')}</button>"],
  // 详情文件列表
  ["      $('#detail-files').innerHTML = `<li style=\"color:var(--muted)\">${s.type === 'file' ? '单文件 SKILL（' + esc(s.folder) + '.md）' : '空目录'}</li>`;",
   "      $('#detail-files').innerHTML = `<li style=\"color:var(--muted)\">${s.type === 'file' ? t('单文件 SKILL（') + esc(s.folder) + '.md）' : t('空目录')}</li>`;"],
  ["      .map((f) => `<li>${f.isDir ? FOLDER_SVG : FILE_SVG}<span>${esc(f.name)}</span><span class=\"fsize\">${f.isDir ? '目录' : fmtSize(f.size)}</span></li>`)",
   "      .map((f) => `<li>${f.isDir ? FOLDER_SVG : FILE_SVG}<span>${esc(f.name)}</span><span class=\"fsize\">${f.isDir ? t('目录') : fmtSize(f.size)}</span></li>`)"],
  // 仪表盘 tiles
  ["  const tiles = [\n    { n: global.length, label: '全局 SKILL' },\n    { n: projSkills.length, label: '项目 SKILL' },\n    { n: state.agents.length, label: 'Agent' },\n    { n: state.projects.length, label: '项目' },\n    { n: links, label: '链接安装' },\n    { n: dupGroups, label: '待合并重复组', warn: dupGroups > 0 },\n  ];",
   "  const tiles = [\n    { n: global.length, label: t('全局 SKILL') },\n    { n: projSkills.length, label: t('项目 SKILL') },\n    { n: state.agents.length, label: t('Agent') },\n    { n: state.projects.length, label: t('项目') },\n    { n: links, label: t('链接安装') },\n    { n: dupGroups, label: t('待合并重复组'), warn: dupGroups > 0 },\n  ];"],
  ["    <div class=\"dash-actions\">\n      <button class=\"btn\" id=\"dash-rescan\">⟳ 重新扫描</button>\n      <button class=\"btn tinted\" id=\"dash-dups\">合并重复</button>\n      <button class=\"btn\" id=\"dash-new\">＋ 新建 SKILL</button>\n      <button class=\"btn\" id=\"dash-import\">导入 SKILL</button>\n    </div>",
   "    <div class=\"dash-actions\">\n      <button class=\"btn\" id=\"dash-rescan\">${t('⟳ 重新扫描')}</button>\n      <button class=\"btn tinted\" id=\"dash-dups\">${t('合并重复')}</button>\n      <button class=\"btn\" id=\"dash-new\">${t('＋ 新建 SKILL')}</button>\n      <button class=\"btn\" id=\"dash-import\">${t('导入 SKILL')}</button>\n    </div>"],
  ["    <div class=\"dash-cols\">\n      <div class=\"agent-block\">\n        <div class=\"dash-sec\">AGENT 分布</div>\n        ${agentRows || '<div class=\"hint\">无</div>'}\n      </div>\n      <div class=\"agent-block\">\n        <div class=\"dash-sec\">项目分布</div>\n        ${projRows}\n      </div>\n    </div>\n    <div class=\"agent-block\">\n      <div class=\"dash-sec\">最近动态 <span class=\"hint\">（共 ${state.logs.length} 条，详见操作日志）</span></div>",
   "    <div class=\"dash-cols\">\n      <div class=\"agent-block\">\n        <div class=\"dash-sec\">${t('AGENT 分布')}</div>\n        ${agentRows || '<div class=\"hint\">' + t('无') + '</div>'}\n      </div>\n      <div class=\"agent-block\">\n        <div class=\"dash-sec\">${t('项目分布')}</div>\n        ${projRows}\n      </div>\n    </div>\n    <div class=\"agent-block\">\n      <div class=\"dash-sec\">${t('最近动态')} <span class=\"hint\">（${tf('共 {n} 条', { n: state.logs.length })}，${t('详见操作日志')}）</span></div>"],
  // dashboard 空项目提示
  ["    : '<div class=\"hint\" style=\"padding:8px 2px\">还没有添加项目，可在「设置 → 项目」中添加。</div>';",
   "    : '<div class=\"hint\" style=\"padding:8px 2px\">' + t('还没有添加项目，可在「设置 → 项目」中添加。') + '</div>';"],
  ["    : '<div class=\"hint\" style=\"padding:8px 2px\">暂无操作记录；安装 / 合并 / 删除的结果都会记录在「操作日志」中。</div>';",
   "    : '<div class=\"hint\" style=\"padding:8px 2px\">' + t('暂无操作记录；安装 / 合并 / 删除的结果都会记录在「操作日志」中。') + '</div>';"],
  // agentRows 目录/缺失
  ["        <span class=\"dash-sub\">${miss ? `<span class=\"dash-warn\">⚠ ${miss} 个目录缺失</span>` : `${a.dirs.length} 个目录`}</span>",
   "        <span class=\"dash-sub\">${miss ? `<span class=\"dash-warn\">⚠ ${tf('{n} 个目录缺失', { n: miss })}</span>` : tf('{n} 个目录', { n: a.dirs.length })}</span>"],
  // 失效 hint
  ["    ${dangling ? `<div class=\"link-hint warn\">⚠ 检测到 ${dangling} 个失效链接（源已被删除），可在列表中筛选清理。</div>` : ''}",
   "    ${dangling ? `<div class=\"link-hint warn\">${tf('⚠ 检测到 {n} 个失效链接（源已被删除），可在列表中筛选清理。', { n: dangling })}</div>` : ''}"],
  // 分区标题
  ["  const sections = [{ title: '全局 SKILL', tag: '', items: state.view.filter((s) => !s.project && match(s)) }]",
   "  const sections = [{ title: t('全局 SKILL'), tag: '', items: state.view.filter((s) => !s.project && match(s)) }]"],
  ["        tag: '项目',", "        tag: t('项目'),"],
  // 空态
  ["      还没有扫描到任何 SKILL。<br>点击右上角「设置」检查各 Agent 的 SKILL 目录，或「新建 SKILL」「导入 SKILL」。</div>`;",
   "      " + "t('还没有扫描到任何 SKILL。<br>点击右上角「设置」检查各 Agent 的 SKILL 目录，或「新建 SKILL」「导入 SKILL」。')" + "</div>`;"],
];
let miss = [];
pairs.forEach(([o, n], i) => {
  if (!s.includes(o)) { miss.push('pair#' + i + ' :: ' + o.slice(0, 60)); return; }
  s = s.split(o).join(n);
});

// ---- 2) 纯静态中文串自动 t() 包裹（跳过注释/已包裹/模板插值行）----
const lines = s.split('\n');
const out = [];
for (const line of lines) {
  const lt = line.trim();
  if (lt.startsWith('//') || lt.startsWith('*') || lt.startsWith('/*')) { out.push(line); continue; }
  out.push(line.replace(/'([^'\n]*)'/g, (full, inner) => {
    if (!CJK.test(inner)) return full;
    const at = out.length; // 当前输出行，无意义占位
    return full; // 占位，下面统一处理
  }));
}
fs.writeFileSync('renderer/app.js', s);
console.log('phase1 done; explicit pair misses:', miss.length);
miss.forEach((m) => console.log('  MISS ' + m));
// 导出剩余未包裹键清单
const remain = [];
{
  const src = fs.readFileSync('renderer/app.js', 'utf8').split('\n');
  src.forEach((line, ln) => {
    const lt = line.trim();
    if (lt.startsWith('//') || lt.startsWith('*')) return;
    if (!CJK.test(line)) return;
    // 统计行内未被 t( 包裹的中文单引号串
    const re = /'([^'\n]*[\u4e00-\u9fff][^'\n]*)'/g;
    let m2;
    while ((m2 = re.exec(line))) {
      const before = line.slice(0, m2.index);
      if (/t\($/.test(before)) continue;
      remain.push(ln + 1 + ': ' + m2[1].slice(0, 60));
    }
  });
}
fs.writeFileSync('.tmp-i18n-keys.txt', remain.join('\n'));
console.log('remaining unwrapped:', remain.length);
