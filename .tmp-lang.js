const fs = require('fs');
const file = 'renderer/app.js';
let s = fs.readFileSync(file, 'utf8');

const anchor = '// 侧栏静态导航项（总览 / 全部 SKILL）是 HTML 写死的节点，在这里统一绑定点击';
if (!s.includes(anchor)) throw new Error('anchor1 未找到');
const langBlock = [
  '// 语言切换：保存偏好 → 翻译静态节点 → 重渲染动态列表',
  "  $('#set-lang').addEventListener('change', (e) => {",
  '    i18n.setLang(e.target.value);',
  '    i18n.apply(document);',
  '    renderSidebar();',
  '    renderGrid();',
  '    updateDupsButton();',
  '    setFilter(state.filter);',
  '  });',
  '',
  anchor,
].join('\n');
s = s.replace(anchor, langBlock, 1);

const init = '(async () => {\n  const p = await api.invoke(\'app:paths\');';
if (!s.includes(init)) throw new Error('anchor2 未找到');
s = s.replace(init, '(async () => {\n  i18n.apply(document);\n  const p = await api.invoke(\'app:paths\');', 1);

const wd = "  $('#wd-status').textContent = '备份内容 = 全局 + 项目内所有实体 SKILL（链接不会上传）；密码保存在本机配置文件中，请注意磁盘安全。';";
if (!s.includes(wd)) throw new Error('anchor3 未找到');
s = s.replace(wd, "  $('#wd-status').textContent = t('备份内容 = 全局 + 项目内所有实体 SKILL（链接不会上传）；密码保存在本机配置文件中，请注意磁盘安全。');", 1);

fs.writeFileSync(file, s);
console.log('app.js lang wiring ok');
