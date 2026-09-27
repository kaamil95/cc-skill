// ESLint 扁平配置：主进程（Node / CommonJS）与渲染层（浏览器）分开声明全局变量，
// 否则 no-undef 会把 preload 暴露的 api、i18n.js 的 i18n 之类误报成未定义。
const js = require('@eslint/js');
const globals = require('globals');
const prettier = require('eslint-config-prettier');

module.exports = [
  {
    ignores: ['node_modules/**', 'dist/**', 'dist2/**', 'user-data/**', '.omc/**', 'assets/**'],
  },

  // 主进程、构建脚本、测试：Node + CommonJS
  {
    files: ['main.js', 'preload.js', 'ipc-channels.js', 'eslint.config.js', 'src/**/*.js', 'test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      // 本项目的 catch (_) { /* 注释 */ } 是有意的「静默兜底」，允许
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    },
  },

  // 渲染层：浏览器全局，外加 preload 暴露的 api、i18n.js 提供的 i18n / t / tf、theme.js 的 theme
  {
    files: ['renderer/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: { ...globals.browser, api: 'readonly', i18n: 'readonly', t: 'readonly', tf: 'readonly', theme: 'readonly' },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    },
  },

  // 关掉与 Prettier 冲突的纯格式规则，必须放最后
  prettier,
];
