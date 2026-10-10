// JSON 着色器与错误翻译的单元测试：从 app.js 抽出真实实现跑，不复制一份免得测试和实现漂移
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'renderer', 'app.js'), 'utf8');

function extractFn(name) {
  const re = new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`);
  const m = src.match(re);
  assert.ok(m, `app.js 里找不到 ${name}`);
  return m[0];
}

const escLine = src.match(/const esc = [^\n]+/)[0];
const highlightJson = new Function(escLine + '\n' + extractFn('highlightJson') + '\nreturn highlightJson;')();
const looksBinary = new Function(extractFn('looksBinary') + '\nreturn looksBinary;')();
// jsonErrorZh 依赖 t/tf，注入直通实现即可
const jsonErrorZh = new Function('t', 'tf', extractFn('jsonErrorZh') + '\nreturn jsonErrorZh;')(
  (s) => s,
  (tpl, vars) => {
    let s = tpl;
    for (const k in vars || {}) s = s.split('{' + k + '}').join(String(vars[k]));
    return s;
  }
);

test('JSON 着色：键/字符串/数字/字面量/标点各归各类', () => {
  const hl = highlightJson('{"name": "demo", "n": 42, "ok": true, "x": null}');
  // esc() 会把引号转成 &quot;，断言按转义后的形态写
  assert.match(hl, /<span class="tok-key">&quot;name&quot;<\/span>:/);
  assert.match(hl, /<span class="tok-str">&quot;demo&quot;<\/span>/);
  assert.match(hl, /<span class="tok-num">42<\/span>/);
  assert.match(hl, /<span class="tok-lit">true<\/span>/);
  assert.match(hl, /<span class="tok-lit">null<\/span>/);
  assert.match(hl, /<span class="tok-pun">\{<\/span>/);
});

test('JSON 着色：字符串内的冒号不拆键值', () => {
  const hl = highlightJson('{"s": "a:b"}');
  assert.match(hl, /<span class="tok-str">&quot;a:b&quot;<\/span>/);
  assert.doesNotMatch(hl, /<span class="tok-key">&quot;a/);
});

test('JSON 着色：HTML 特殊字符被转义，不破坏页面', () => {
  const hl = highlightJson('{"s": "<script>"}');
  assert.ok(!hl.includes('<script>'), '内容里的尖括号必须转义');
  assert.match(hl, /&lt;script&gt;/);
});

test('looksBinary：文本放行，控制字符拦截', () => {
  const nul = String.fromCharCode(0);
  assert.equal(looksBinary('{"a": 1}\n\t'), false);
  assert.equal(looksBinary('a' + nul + 'b'), true);
});

test('jsonErrorZh：常见语法错误给出中文提示并带行列号', () => {
  const cases = [
    // 少逗号：位置指向第二个键（第 3 行）
    ['{\n  "a": "x"\n  "b": 1\n}', /属性之间可能缺少逗号|意外的符号/, /第 3 行第 \d+ 列/],
    // 括号没闭合：V8 可能报「Unexpected end」也可能报「Expected ',' or ']'」
    ['{\n  "a": [1, 2', /不完整|缺少结束的 \]|意外的符号/, /第 \d+ 行第 \d+ 列/],
    // 单引号属性名
    ["{\n  'a': 1\n}", /属性名要用双引号|意外的符号/],
    // 空输入
    ['', /不完整/],
    // 多余尾随内容
    ['{"a":1} extra', /多余内容/],
  ];
  for (const [text, ...patterns] of cases) {
    let err;
    try {
      JSON.parse(text);
    } catch (e) {
      err = e;
    }
    assert.ok(err, '用例应能触发 JSON 解析错误');
    const msg = jsonErrorZh(text, err);
    assert.ok(![...msg].some((ch) => ch.charCodeAt(0) < 32), '不应夹带控制字符: ' + msg);
    for (const p of patterns) assert.match(msg, p, `用例「${text.slice(0, 20)}」的提示: ${msg}`);
  }
});

test('jsonErrorZh：正确解析的输入不该走到这里，函数只认错误对象', () => {
  // 防御：给一个可解析的输入构造不出错误，直接喂假错误走兜底分支
  const msg = jsonErrorZh('{"a":1}', { message: 'some unknown failure' });
  assert.match(msg, /JSON 语法错误/);
});
