// 打包 / 解压。Windows 走 PowerShell 的 Compress-Archive / Expand-Archive，
// macOS / Linux 走系统 zip / unzip。不依赖 electron。
const fs = require('fs');
const { execFile } = require('child_process');
const { IS_WIN, ps } = require('./paths');

function runPowerShell(cmd) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd],
      { timeout: 120000, windowsHide: true },
      (err) => (err ? reject(err) : resolve())
    );
  });
}

async function packZip(tmpRoot, zipPath) {
  if (IS_WIN) {
    await runPowerShell(`Compress-Archive -Path '${ps(tmpRoot)}\\*' -DestinationPath '${ps(zipPath)}' -Force`);
    return;
  }
  await new Promise((resolve, reject) => {
    execFile('zip', ['-r', '-q', zipPath, '.'], { cwd: tmpRoot, windowsHide: true }, (e) => (e ? reject(e) : resolve()));
  });
}

async function unpackZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (IS_WIN) {
    return runPowerShell(`Expand-Archive -LiteralPath '${ps(zipPath)}' -DestinationPath '${ps(destDir)}' -Force`);
  }
  await new Promise((resolve, reject) => {
    execFile('unzip', ['-o', zipPath, '-d', destDir], { windowsHide: true }, (e) => (e ? reject(e) : resolve()));
  });
}

module.exports = { runPowerShell, packZip, unpackZip };
