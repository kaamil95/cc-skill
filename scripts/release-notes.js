// 从 CHANGELOG.md 抽出某个版本那一节，作为 GitHub Release 的正文。
//
// 发版说明本来就写在 CHANGELOG 里（人写的那段），没必要在 Release 上再手写一遍。
// 抽不到就什么都不输出，工作流会退回 GitHub 自动生成的说明。
//
// 用法：node scripts/release-notes.js v0.0.2 > release-notes.md
const fs = require('fs');
const path = require('path');

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** markdown 里 `## [version]`（或 `## version`）那一节的正文，不含标题行；找不到返回 '' */
function sectionFor(markdown, version) {
  const head = new RegExp('^##\\s*\\[?' + escapeRe(version) + '\\]?(?:\\s|$)');
  const out = [];
  let inside = false;
  for (const line of String(markdown).split(/\r?\n/)) {
    if (/^##\s/.test(line)) {
      if (inside) break; // 撞到下一个二级标题，本节结束
      inside = head.test(line);
      continue;
    }
    if (inside) out.push(line);
  }
  return out.join('\n').trim();
}

function main() {
  const version = String(process.argv[2] || '')
    .trim()
    .replace(/^v/i, '');
  if (!version) {
    process.stderr.write('用法：node scripts/release-notes.js <版本号，可带 v 前缀>\n');
    process.exit(2);
  }
  let markdown;
  try {
    markdown = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
  } catch (_) {
    return; // 没有 CHANGELOG 就让 GitHub 自己生成说明
  }
  const body = sectionFor(markdown, version);
  if (body) process.stdout.write(body + '\n');
}

if (require.main === module) main();

module.exports = { sectionFor };
