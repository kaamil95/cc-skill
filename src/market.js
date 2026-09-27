// SKILL 市场：从 GitHub 仓库 / 直链 zip / 索引源里把 SKILL 找出来并取回本地。
// 网络走 src/net.js（可注入），解压复用 src/zip.js，因此测试能全程离线跑。
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./paths');
const { insideDir } = require('./nav');
const { httpGet, downloadToFile } = require('./net');
const { unpackZip } = require('./zip');
const { parseFrontmatter, firstParagraph, countFiles } = require('./skills');

const GITHUB_API = 'https://api.github.com';
const CODELOAD = 'https://codeload.github.com';
// 仓库里这些目录不用找 SKILL：要么是依赖，要么是构建产物，扫进去只会拖慢并刷出噪声
const SKIP_DIRS = new Set(['node_modules', '.git', '.github', 'dist', 'build', 'out', '.venv', 'venv', '__pycache__', '.next', 'target']);
const MAX_DEPTH = 5;

// token 只发给 GitHub 自己的域名。索引地址与 zip 链接都是用户填的任意 URL，
// 无脑带上 Authorization 等于把 token 送给任何一台被填进来的主机。
const GH_HOST_RE = /(^|\.)(github\.com|githubusercontent\.com)$/i;
function isGithubHost(url) {
  try {
    return GH_HOST_RE.test(new URL(String(url)).hostname);
  } catch (_) {
    return false;
  }
}

const ghHeaders = (token, url) => ({
  accept: 'application/vnd.github+json',
  'user-agent': 'cc-skill',
  ...(token && isGithubHost(url) ? { authorization: 'Bearer ' + token } : {}),
});

// ------------------------------ 链接 / 仓库解析 -------------------------------
/**
 * 从各种写法里解出 { owner, repo, ref, path }：
 *   owner/repo · owner/repo/tree/main/skills/x · https://github.com/o/r
 *   https://github.com/o/r/tree/main/sub/dir · …/archive/refs/heads/main.zip
 *   git@github.com:o/r.git · https://codeload.github.com/o/r/zip/main
 */
function parseRepoRef(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  s = s.replace(/^git\+/, '');

  if (/^(https?:\/\/|git@)/i.test(s)) {
    const m = /github\.com[:/]([\w.-]+)\/([\w.-]+)/i.exec(s);
    if (!m) return null;
    const owner = m[1];
    const repo = m[2].replace(/\.git$/i, '');
    const tree = /\/(?:tree|blob)\/([^/?#]+)(?:\/([^?#]+))?/.exec(s);
    const archive = /\/archive\/(?:refs\/heads\/)?([^/?#]+?)(?:\.zip)?(?:[?#]|$)/.exec(s);
    const codeload = /\/zip\/(?:refs\/heads\/)?([^/?#]+)/.exec(s);
    return {
      owner,
      repo,
      ref: tree ? decodeURIComponent(tree[1]) : archive ? archive[1] : codeload ? codeload[1] : '',
      path: tree && tree[2] ? decodeURIComponent(tree[2]) : '',
    };
  }

  const m = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/]+)(?:\/(.*))?)?$/.exec(s);
  if (!m) return null;
  return { owner: m[1], repo: m[2], ref: m[3] || '', path: m[4] || '' };
}

/** 用户粘进来的一串东西 → 可执行的数据源。认不出来返回 null */
function parseSource(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw) && !/github\.com/i.test(raw)) {
    return /\.zip(?:[?#]|$)/i.test(raw) ? { kind: 'zip', url: raw } : null;
  }
  const ref = parseRepoRef(raw);
  return ref ? { kind: 'github', ...ref } : null;
}

// ------------------------------ GitHub 搜索 ---------------------------------
function mapRepo(item) {
  return {
    fullName: item.full_name,
    description: item.description || '',
    stars: item.stargazers_count || 0,
    updatedAt: item.pushed_at || item.updated_at || '',
    url: item.html_url,
    owner: (item.owner && item.owner.login) || '',
    repo: item.name || '',
    defaultBranch: item.default_branch || '',
  };
}

async function searchGithub(query, { token, page = 1, perPage = 20 } = {}) {
  const q = String(query || '').trim();
  if (!q) return { ok: true, total: 0, items: [] };
  const url = `${GITHUB_API}/search/repositories?q=${encodeURIComponent(q + ' in:name,description,readme')}&sort=stars&order=desc&per_page=${perPage}&page=${page}`;
  const data = await httpGet(url, { headers: ghHeaders(token, url), expectJson: true, timeoutMs: 20000 });
  return { ok: true, total: data.total_count || 0, items: (data.items || []).map(mapRepo) };
}

// ------------------------------ 索引源 --------------------------------------
/** 索引里的一条：repo 与 url 二选一，其余字段可省。缺关键字段的条目直接丢弃 */
function normalizeIndexEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const name = typeof e.name === 'string' ? e.name.trim() : '';
  if (!name) return null;
  const repo = typeof e.repo === 'string' ? parseRepoRef(e.repo) : null;
  const url = typeof e.url === 'string' && /^https?:\/\//i.test(e.url.trim()) ? e.url.trim() : '';
  if (!repo && !url) return null;
  const sub = typeof e.path === 'string' ? e.path.trim() : '';
  const ref = typeof e.ref === 'string' ? e.ref.trim() : '';
  return {
    name,
    description: typeof e.description === 'string' ? e.description.trim() : '',
    tags: Array.isArray(e.tags) ? e.tags.filter((x) => typeof x === 'string').slice(0, 6) : [],
    source: repo ? { kind: 'github', ...repo, path: sub || repo.path, ref: ref || repo.ref } : { kind: 'zip', url },
  };
}

/**
 * 拉取并归一化索引 JSON：
 *   { "version": 1, "name": "…", "skills": [{ name, description, repo|url, path, ref, tags }] }
 * 脏条目跳过并计数——一条写错的记录不该让整个索引不可用。
 */
async function fetchIndex(url, { token } = {}) {
  const target = String(url || '').trim();
  if (!target) throw new Error('索引地址为空');
  const data = await httpGet(target, { headers: ghHeaders(token, target), expectJson: true, timeoutMs: 20000 });
  // 顶层数组也认；认不出来就报错——静默当成「空索引」会让用户以为索引是空的
  const list = Array.isArray(data) ? data : data && Array.isArray(data.skills) ? data.skills : null;
  if (!list) throw new Error('索引格式不对：顶层应是 { "skills": [ … ] }');
  const items = [];
  let skipped = 0;
  for (const e of list) {
    const entry = normalizeIndexEntry(e);
    if (entry) items.push(entry);
    else skipped++;
  }
  return { ok: true, name: data && typeof data.name === 'string' ? data.name : '', items, skipped };
}

// ------------------------------ 取回并列出 SKILL ------------------------------
/** GitHub 的 zip 会多套一层 <repo>-<ref>/，解压后要钻进这一层 */
function extractRoot(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return dir;
  }
  const dirs = entries.filter((e) => e.isDirectory());
  const files = entries.filter((e) => e.isFile());
  return dirs.length === 1 && files.length === 0 ? path.join(dir, dirs[0].name) : dir;
}

function skillEntry(dir, root) {
  let meta = { name: null, description: null };
  let body = '';
  try {
    const parsed = parseFrontmatter(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'));
    meta = parsed.meta;
    body = parsed.body;
  } catch (_) {
    /* 读不出来就退回目录名 */
  }
  return {
    relPath: path.relative(root, dir).split(path.sep).join('/'),
    absPath: dir,
    // 供渲染层直接拿去 skill:read —— skill:read 要的是 SKILL.md 的文件路径，不是目录
    skillMdPath: path.join(dir, 'SKILL.md'),
    name: meta.name || path.basename(dir),
    description: meta.description || firstParagraph(body) || '',
    fileCount: countFiles(dir),
  };
}

/** 深度优先找出所有含 SKILL.md 的目录；命中即止，不再往里找嵌套的 SKILL */
function listSkillDirs(root) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name.toLowerCase() === 'skill.md')) {
      out.push(skillEntry(dir, root));
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

/** 上一次取回仓库留下的解压目录：下次取回前先删掉，别把 %TEMP% 堆满 */
let lastExtract = '';

/** 下载 → 解压 → 列出其中所有 SKILL。临时目录沿用 cc-skill-import-<ts>，
    这样 src/paths.js 的 sweepStaleTempDirs 启动时会顺手清掉残留，不必另写清理逻辑 */
async function inspectSource(source, { token } = {}) {
  if (!source || (source.kind !== 'github' && source.kind !== 'zip')) throw new Error('无法识别的来源');
  // 主进程再校验一次 scheme：渲染层传什么都不能让 net.fetch 去碰 file:// 这类本地协议
  if (source.kind === 'zip' && !/^https?:\/\//i.test(String(source.url || ''))) throw new Error('只支持 http(s) 的压缩包地址');

  if (lastExtract) fs.rmSync(lastExtract, { recursive: true, force: true });
  const tmpRoot = path.join(tempDir(), 'cc-skill-import-' + Date.now());
  lastExtract = tmpRoot;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
  const zipPath = tmpRoot + '.zip';

  let label;
  if (source.kind === 'github') {
    label = `${source.owner}/${source.repo}${source.ref ? '@' + source.ref : ''}`;
    const zipUrl = `${CODELOAD}/${source.owner}/${source.repo}/zip/${source.ref || 'HEAD'}`;
    await downloadToFile(zipUrl, zipPath, {
      headers: ghHeaders(token, zipUrl),
      timeoutMs: 180000,
    });
  } else {
    label = source.url;
    await downloadToFile(source.url, zipPath, { timeoutMs: 180000 });
  }

  await unpackZip(zipPath, tmpRoot);
  fs.rmSync(zipPath, { force: true });

  const root = extractRoot(tmpRoot);
  // 索引/树链接里带的子路径是「仓库根之下」的相对路径，解压后的根就是仓库根。
  // 必须做包含校验：索引条目是第三方内容，写 ../../.. 就能让 listSkillDirs 去扫仓库之外，
  // 扫出来的目录还会被当成可安装的 SKILL 交给 skill:copy。
  const scope = source.path ? path.join(root, source.path) : root;
  if (!insideDir(root, scope)) throw new Error('来源里的子路径越出了仓库范围：' + source.path);
  const skills = fs.existsSync(scope) ? listSkillDirs(scope) : [];
  return { ok: true, label, root: scope, tempRoot: tmpRoot, skills };
}

module.exports = { parseRepoRef, parseSource, searchGithub, fetchIndex, normalizeIndexEntry, inspectSource, listSkillDirs };
