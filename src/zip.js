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

/** zip-slip 防护：解压前解析中央目录的条目名，拒绝路径穿越条目。
    Expand-Archive / unzip 都按字面量解压 `../`，恶意 zip（市场 zip 直链、外部导入）
    能把文件写到目标目录之外 —— 校验必须在解压之前，解压后就晚了。
    只读文件名不解内容：zip 太深太怪的部分（加密/描述符）不关心，解析失败即拒绝。 */
async function zipEntryNames(zipPath) {
  const fh = await fs.promises.open(zipPath, 'r');
  try {
    const size = (await fh.stat()).size;
    // EOCD 可能带最多 65535 字节的注释，从文件尾部往回扫
    const tailLen = Math.min(size, 22 + 65535);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('不是有效的 zip 文件');
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset === 0xffffffff || cdSize === 0xffffffff) {
      // zip64：EOCD 里的偏移是占位符，真值在 zip64 EOCD（经 locator 定位）
      const loc = eocd - 20;
      if (loc < 0 || tailLen < loc + 20 || tail.readUInt32LE(loc) !== 0x07064b50) throw new Error('zip64 目录定位失败');
      const z64Offset = Number(tail.readBigUInt64LE(loc + 8));
      const z64 = Buffer.alloc(56);
      await fh.read(z64, 0, z64.length, z64Offset);
      if (z64.readUInt32LE(0) !== 0x06064b50) throw new Error('zip64 目录损坏');
      cdSize = Number(z64.readBigUInt64LE(40));
      cdOffset = Number(z64.readBigUInt64LE(48));
    }
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    const names = [];
    let p = 0;
    while (p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50) {
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      names.push(cd.toString('utf8', p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;
    }
    return names;
  } finally {
    await fh.close();
  }
}

function assertZipSafe(names) {
  const evil = names.filter((raw) => {
    const name = String(raw).replace(/\\/g, '/');
    if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return true;
    return name.split('/').some((seg) => seg === '..');
  });
  if (evil.length) throw new Error(`zip 内含不安全的路径条目：${evil.slice(0, 3).join('、')}`);
}

async function unpackZip(zipPath, destDir) {
  // 校验先于任何解压： Expand-Archive / unzip 都不会替我们拦 `../`
  assertZipSafe(await zipEntryNames(zipPath));
  fs.mkdirSync(destDir, { recursive: true });
  if (IS_WIN) {
    return runPowerShell(`Expand-Archive -LiteralPath '${ps(zipPath)}' -DestinationPath '${ps(destDir)}' -Force`);
  }
  await new Promise((resolve, reject) => {
    execFile('unzip', ['-o', zipPath, '-d', destDir], { windowsHide: true }, (e) => (e ? reject(e) : resolve()));
  });
}

module.exports = { runPowerShell, packZip, unpackZip, zipEntryNames, assertZipSafe };
