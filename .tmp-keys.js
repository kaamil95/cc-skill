// 提取 t()/tf() 键，核对 EN 词典覆盖
const fs = require('fs');
const src = fs.readFileSync('renderer/app.js', 'utf8');
const i18nSrc = fs.readFileSync('renderer/i18n.js', 'utf8');
const keys = new Set();
const re = /\b(?:t|tf)\('((?:[^'\\]|\\.)*)'\)/g;
let m;
while ((m = re.exec(src))) keys.add(m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\'));
const dictKeys = new Set();
const dre = /\n    '((?:[^'\\]|\\.)*)':/g;
while ((m = dre.exec(i18nSrc))) dictKeys.add(m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\'));
const missing = [...keys].filter((k) => !dictKeys.has(k));
console.log('keys:', keys.size, '| dict:', dictKeys.size, '| missing:', missing.length);
missing.forEach((k) => console.log('  MISS-KEY: ' + k.slice(0, 70)));
