// 主进程面向用户的消息：只有中英两套，跟随系统语言。
// （渲染层的 renderer/i18n.js 是另一套，负责界面文案。）
let uiEn = false;

function initMainMessages(locale) {
  uiEn = !String(locale || '')
    .toLowerCase()
    .startsWith('zh');
}

const M = (zh, en) => (uiEn ? en : zh);

module.exports = { initMainMessages, M };
