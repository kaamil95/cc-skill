// zip-slip 防护：解压前解析中央目录条目名，路径穿越条目必须被拒在解压之前
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { unpackZip, zipEntryNames, assertZipSafe } = require('../../src/zip');

// 手工拼最小 zip 字节流：我们只解析中央目录，所以条目只需中央目录头 + EOCD，
// 本地文件头仅占位（让字节偏移对得上，内容不参与解析）
function craftZip(entries) {
  const parts = [];
  let offset = 0;
  for (const name of entries) {
    const nb = Buffer.from(name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(nb.length, 26);
    parts.push(lh, nb);
    offset += 30 + nb.length;
  }
  const cdStart = offset;
  const cdParts = [];
  for (const name of entries) {
    const nb = Buffer.from(name, 'utf8');
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0); // central directory header signature
    h.writeUInt16LE(nb.length, 28); // file name length
    h.writeUInt16LE(0, 30); // extra length
    h.writeUInt16LE(0, 32); // comment length
    cdParts.push(h, nb);
  }
  const cdSize = cdParts.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  return Buffer.concat([...parts, ...cdParts, eocd]);
}

function tmpZip(buf) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-skill-zip-'));
  const file = path.join(dir, 't.zip');
  fs.writeFileSync(file, buf);
  return file;
}

test('assertZipSafe：../ 与绝对路径与盘符都拦下，正常相对路径放行', () => {
  assert.throws(() => assertZipSafe(['a/SKILL.md', '../evil.txt']), /不安全的路径/);
  assert.throws(() => assertZipSafe(['a/../../evil.txt']), /不安全的路径/);
  assert.throws(() => assertZipSafe(['a\\..\\evil.txt']), /不安全的路径/, '反斜杠分隔也要拦');
  assert.throws(() => assertZipSafe(['/abs/evil.txt']), /不安全的路径/);
  assert.throws(() => assertZipSafe(['C:evil.txt']), /不安全的路径/);
  assert.doesNotThrow(() => assertZipSafe(['skills/x/SKILL.md', 'b.txt']));
});

test('zipEntryNames：能读出手工 zip 的条目名，坏结构报错而不是静默', async () => {
  const good = tmpZip(craftZip(['skills/a/SKILL.md', 'b.txt']));
  assert.deepEqual(await zipEntryNames(good), ['skills/a/SKILL.md', 'b.txt']);
  const notZip = tmpZip(Buffer.from('hello, definitely not a zip'));
  assert.rejects(() => zipEntryNames(notZip), /不是有效的 zip/);
});

test('unpackZip：穿越条目在解压前被拒，目标目录不会被创建', async () => {
  const evil = tmpZip(craftZip(['ok.txt', '../evil.txt']));
  const dest = path.join(os.tmpdir(), 'cc-slip-dest-' + Date.now());
  await assert.rejects(() => unpackZip(evil, dest), /不安全的路径/);
  assert.ok(!fs.existsSync(dest), '被拒的解压不该留下目标目录');

  // 深一层：.. 藏在合法路径中间
  const sneaky = tmpZip(craftZip(['docs/../../evil.txt']));
  await assert.rejects(() => unpackZip(sneaky, path.join(os.tmpdir(), 'cc-slip-dest2-' + Date.now())), /不安全的路径/);
});
