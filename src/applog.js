// 操作日志落盘：主进程与 IPC 层共用同一套行格式。
// 抽出来是为了让「界面加载失败 / 导航被拦截」这类主进程事件和渲染层的操作记录
// 落进同一个 cc-skill.log，事后排查时顺序与格式都是统一的。
const fs = require('fs');

function logLine(file, type, msg) {
  try {
    const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] [${String(type || 'info').toUpperCase()}] ${msg}\n`;
    fs.appendFileSync(file, line, 'utf8');
    return { ok: true };
  } catch (err) {
    // 日志写不进去绝不能反过来影响主流程
    return { ok: false, error: String((err && err.message) || err) };
  }
}

module.exports = { logLine };
