// 测试数据构造：实体 SKILL 目录 / 单文件 SKILL / 配置对象
const path = require('path');
const fs = require('fs');

/** 在 parentDir 下创建一个实体 SKILL 文件夹，返回其绝对路径 */
function writeSkill(parentDir, name, { description, files } = {}) {
  const dir = path.join(parentDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description || name + ' 的描述'}\n---\n\n# ${name}\n\n正文内容。\n`, 'utf8');
  for (const [rel, content] of Object.entries(files || {})) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return dir;
}

/** 单文件形式的 SKILL：<parentDir>/<name>.md */
function writeFlatSkill(parentDir, name) {
  fs.mkdirSync(parentDir, { recursive: true });
  const file = path.join(parentDir, name + '.md');
  fs.writeFileSync(file, `---\nname: ${name}\ndescription: ${name} 的单文件描述\n---\n\n# ${name}\n`, 'utf8');
  return file;
}

function makeConfig({ agentDirs = [], projects = [], webdav = null, ui = { lang: 'zh' } } = {}) {
  return {
    agents: [{ id: 'claude-code', name: 'Claude Code', color: '#e07a4f', dirs: agentDirs }],
    projects,
    ui,
    ...(webdav ? { webdav } : {}),
  };
}

function makeWebdavConfig(url, remotePath = 'dav') {
  return { url, username: 'u', password: 'p', remotePath, autoBackup: false, autoBackupFreq: 'startup' };
}

// realpath 一次：macOS 的 /var 是指向 /private/var 的符号链接，
// 不归一化的话「链接指向的唯一副本」和「扫描到的唯一副本」会因为前缀不同而匹配不上
function tmpDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(require('os').tmpdir(), prefix)));
}

/** 用系统自带的 Compress-Archive 打包，刻意不复用 src/zip.js——测试的输入不该由被测代码生成 */
function zipDir(srcDir, zipPath) {
  const { execFileSync } = require('child_process');
  const ps = (s) => String(s).replace(/'/g, "''");
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `Compress-Archive -Path '${ps(path.join(srcDir, '*'))}' -DestinationPath '${ps(zipPath)}' -Force`,
    ],
    { windowsHide: true }
  );
  return zipPath;
}

module.exports = { writeSkill, writeFlatSkill, makeConfig, makeWebdavConfig, tmpDir, zipDir };
