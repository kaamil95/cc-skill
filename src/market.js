// SKILL 市场：从 GitHub 仓库 / 直链 zip / 索引源里把 SKILL 找出来并取回本地。
// 网络走 src/net.js（可注入），解压复用 src/zip.js，因此测试能全程离线跑。
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./paths');
const { insideDir } = require('./nav');
const { httpGet, httpPostJson, downloadToFile } = require('./net');
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

async function searchGithub(query, { token, page = 1, perPage = 20, budgetMs = SEARCH_BUDGET_MS } = {}) {
  const q = String(query || '').trim();
  if (!q) return { ok: true, total: 0, items: [] };
  const url = `${GITHUB_API}/search/repositories?q=${encodeURIComponent(q + ' in:name,description,readme')}&sort=stars&order=desc&per_page=${perPage}&page=${page}`;
  const data = await httpGet(url, { headers: ghHeaders(token, url), expectJson: true, timeoutMs: budgetMs });
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

// ------------------------------ 内置市场 -------------------------------------
// 第一批接入的两个站都有公开检索接口，且 SKILL 都落在 GitHub 仓库里 —— 安装复用
// 同一条 github → codeload zip 管道，不引入第二种下载路径。没有公开接口的站
// （skillhub.cn 等）等它们提供 API 再登记进来，这份清单就是唯一的扩展点。
// ------------------------------ 统一检索 -------------------------------------
// 用户不该关心「从哪个来源搜」：一个搜索框，一次请求，来源只是行上的徽章。
// 各来源并行跑，每个来源一份时间预算 —— 单个来源慢/挂了不拖垮整体，列表照常渲染。

// 单来源时间预算：正常网络下整个聚合检索 3s 内出列表；最坏情况（某来源死了）也就等
// 这么久，而不是陪着它跑满自己的 20s 超时。8s 是「慢但值得等」和「明显卡了」的分界。
const SEARCH_BUDGET_MS = 6000;

/** 给一个 Promise 上时间预算：到点就放弃等待（被放弃的 Promise 继续在后台跑，缓存照常热起来） */
function withBudget(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + ' 超时')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** skills.sh 检索：站方接口只给 name/installs/skillId/source（没有描述——实测确认），
    且不支持服务端分页（page/limit 参数实测被忽略）——一次响应就是全量。
    所以这里按查询词把整表缓存住，每次只切一页出去：线上少量多次，不用反复打站方接口。 */
const SKILLSH_PAGE = 20;
const SKILLSH_TTL = 30 * 60 * 1000;
const skillsShCache = new Map(); // query → { items, t }

async function searchSkillsSh(q, { budgetMs = SEARCH_BUDGET_MS, page = 1 } = {}) {
  const query = String(q || '').trim();
  let hit = skillsShCache.get(query);
  if (!hit || Date.now() - hit.t > SKILLSH_TTL) {
    const url = `https://www.skills.sh/api/search?q=${encodeURIComponent(query)}`;
    const data = await httpGet(url, { expectJson: true, timeoutMs: budgetMs });
    const items = [];
    for (const s of Array.isArray(data.skills) ? data.skills : []) {
      // source 是 "owner/repo"；skillId 是站内的 SKILL 名，仓库里的目录名与它同名（已核对过
      // 主流仓库的布局）。描述与路径不在检索期解析 —— 渲染层拿到列表后按行回填
      const ref = parseRepoRef(typeof s.source === 'string' ? s.source : '');
      if (!ref) continue;
      items.push({
        name: typeof s.name === 'string' && s.name.trim() ? s.name.trim() : ref.repo,
        description: '',
        source: { kind: 'github', owner: ref.owner, repo: ref.repo, ref: '', path: '' },
        meta: { installs: typeof s.installs === 'number' ? s.installs : 0, skillId: typeof s.skillId === 'string' ? s.skillId : '' },
      });
    }
    hit = { items, t: Date.now() };
    // 缓存只留最近的查询词：它是加速器不是存储，别让它悄悄吃内存
    if (skillsShCache.size >= 30) skillsShCache.delete(skillsShCache.keys().next().value);
    skillsShCache.set(query, hit);
  }
  const start = (Math.max(1, page) - 1) * SKILLSH_PAGE;
  return { ok: true, total: hit.items.length, items: hit.items.slice(start, start + SKILLSH_PAGE) };
}

async function searchSkillsMp(q, { page = 1, perPage = 20, budgetMs = SEARCH_BUDGET_MS } = {}) {
  const url = `https://skillsmp.com/api/v1/skills/search?q=${encodeURIComponent(String(q || '').trim())}&page=${page}&limit=${perPage}&sortBy=stars`;
  const data = await httpGet(url, { expectJson: true, timeoutMs: budgetMs });
  const list = data && data.data && Array.isArray(data.data.skills) ? data.data.skills : [];
  const items = [];
  for (const s of list) {
    // githubUrl 是 tree 链接，现有解析器一拆就是 owner/repo/ref/path —— 安装直落子目录
    const ref = parseRepoRef(typeof s.githubUrl === 'string' ? s.githubUrl : '');
    if (!ref) continue;
    items.push({
      name: typeof s.name === 'string' && s.name.trim() ? s.name.trim() : ref.repo,
      description: typeof s.description === 'string' ? s.description : '',
      source: { kind: 'github', owner: ref.owner, repo: ref.repo, ref: ref.ref, path: ref.path },
      meta: { stars: typeof s.stars === 'number' ? s.stars : 0, author: typeof s.author === 'string' ? s.author : '' },
    });
  }
  return { ok: true, total: items.length, items };
}

// ------------------------------ SkillHub 目录 --------------------------------
// skillhub.club 的桌面端接口是公开的（学习 skillhub-desktop 得来）：整页条目自带
// 描述 / 星标 / 分类 / 标签，repo_url 直指 SKILL 在仓库里的位置 —— 一次请求就是
// 一页完整的「发现」列表，零配额零配置。聚合仓的 #hash 形态链接也在此拆开。
const SKILLHUB_API = 'https://www.skillhub.club/api/v1/desktop';
const SKILLHUB_LIST_MAX = 30;

/** SkillHub 的 repo_url 有两种形态：tree 链接与 #hash 片段（聚合仓约定），
    顺带处理 `#skills-xxx` → `skills/xxx` 的聚合仓路径习惯（同 skillhub-desktop） */
function parseSkillhubRepoUrl(url) {
  const m = /github\.com\/([\w.-]+)\/([\w.-]+)/.exec(String(url || ''));
  if (!m) return null;
  const owner = m[1];
  const repo = m[2].replace(/\.git$/, '');
  let path = '';
  let ref = '';
  const tree = /\/tree\/([^/]+)(?:\/([^#]+))?/.exec(url);
  if (tree) {
    ref = tree[1];
    path = tree[2] || '';
  } else {
    const hash = /#(.+)$/.exec(url);
    if (hash) path = hash[1].replace(/~/g, '/');
  }
  if (path && !path.includes('/') && path.startsWith('skills-')) path = 'skills/' + path.slice('skills-'.length);
  return { owner, repo, ref, path };
}

/** SkillHub 检索 / 目录：有关键词走 search，无关键词（含分类浏览）走 catalog。
    catalog 支持分页（page），search 接口无分页参数 —— 翻页翻不出新条目时上层据此停手 */
async function searchSkillhub(q, { budgetMs = SEARCH_BUDGET_MS, category = '', sortBy = 'popular', page = 1 } = {}) {
  const query = String(q || '').trim();
  let data;
  if (query) {
    data = await httpPostJson(`${SKILLHUB_API}/search`, { query, limit: SKILLHUB_LIST_MAX }, { timeoutMs: budgetMs });
  } else {
    let url = `${SKILLHUB_API}/catalog?page=${page}&limit=${SKILLHUB_LIST_MAX}`;
    if (category) url += `&category=${encodeURIComponent(category)}`;
    if (sortBy && sortBy !== 'popular') url += `&sortBy=${encodeURIComponent(sortBy)}`;
    data = await httpGet(url, { expectJson: true, timeoutMs: budgetMs });
  }
  const list = data && Array.isArray(data.skills) ? data.skills : [];
  const items = [];
  for (const s of list) {
    const ref = parseSkillhubRepoUrl(s.repo_url);
    if (!ref) continue;
    const tags = Array.isArray(s.tags) ? s.tags.filter((x) => typeof x === 'string').slice(0, 4) : [];
    items.push({
      name: typeof s.name === 'string' && s.name.trim() ? s.name.trim() : ref.repo,
      description: typeof s.description === 'string' ? s.description : '',
      source: { kind: 'github', owner: ref.owner, repo: ref.repo, ref: ref.ref, path: ref.path },
      meta: {
        stars: typeof s.github_stars === 'number' ? s.github_stars : 0,
        author: typeof s.author === 'string' ? s.author : '',
        skillId: ref.path ? ref.path.split('/').filter(Boolean).pop() : '',
        category: typeof s.category === 'string' ? s.category : '',
      },
      tags: s.category && !tags.includes(s.category) ? [s.category, ...tags] : tags,
    });
  }
  return { ok: true, total: items.length, items };
}

// ------------------------------ SKILL 定位与取回 ------------------------------
// skills.sh 的检索接口只有 name/installs/skillId/source：没描述，也没有 SKILL 在仓库里的
// 路径。两样都靠仓库树定位：一次请求拿到全仓路径（同一仓库的多个 SKILL 共用），
// 目录名与 skillId 同名的那个就是目标。拿到路径后描述、详情、单技能安装都不必下整仓 zip。
//
// 取数顺序是「权威优先、能省则省」：
//   · GitHub 官方 API（树 / contents 内联 base64）—— 与仓库当前状态一致，但要配额：
//     匿名 60 次/小时，配了 Token 是 5000。额度耗尽会 429，所以命中率靠缓存与「只解析前若干条」兜。
//   · jsDelivr 清单与 CDN —— 不限流，但它的 @HEAD 清单可能滞后于仓库（实测见过它列出
//     已经不在默认分支里的目录），所以只当兜底，不当唯一依据。
//   · raw.githubusercontent —— 最后兜底（部分网络不可达）。
// 三条都拿不到时描述留空，市场照常可用；界面会提示可以填 Token。
const GITHUB_RAW = 'https://raw.githubusercontent.com';
const JSDELIVR_DATA = 'https://data.jsdelivr.com/v1/package/gh';
const JSDELIVR_CDN = 'https://cdn.jsdelivr.net/gh';
const TREE_TTL = 30 * 60 * 1000;
const TREE_CACHE_MAX = 120;
const SKILL_TTL = 24 * 60 * 60 * 1000;
const SKILL_CACHE_MAX = 500;
// 单技能取回的文件上限：超过就说明这不是一个 SKILL 而是一整个仓库，退回整仓流程
const MAX_SKILL_FILES = 80;

const treeCache = new Map(); // owner/repo → { paths, t }
const skillCache = new Map(); // owner/repo/skillId → { description, path, t }

/** jsDelivr 的仓库文件清单（不限流，但可能滞后于仓库当前状态） */
async function jsdelivrTree(owner, repo, { fetcher = httpGet } = {}) {
  const url = `${JSDELIVR_DATA}/${owner}/${repo}@HEAD/flat`;
  const data = await fetcher(url, { expectJson: true, timeoutMs: 20000 });
  const files = Array.isArray(data && data.files) ? data.files : [];
  return files.map((f) => String((f && f.name) || '').replace(/^\//, '')).filter(Boolean);
}

/** GitHub 官方树接口：与仓库当前状态一致，代价是配额 */
async function githubTree(owner, repo, { token, fetcher = httpGet } = {}) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`;
  const data = await fetcher(url, { headers: ghHeaders(token, url), expectJson: true, timeoutMs: 20000 });
  return (Array.isArray(data && data.tree) ? data.tree : []).filter((t) => t && t.type === 'blob' && typeof t.path === 'string').map((t) => t.path);
}

/** 仓库全量路径，带 TTL 缓存：同一个仓库下的多个 SKILL 只拉一次 */
async function repoTree(owner, repo, opts = {}) {
  const key = `${owner}/${repo}`;
  const hit = treeCache.get(key);
  if (hit && Date.now() - hit.t < TREE_TTL) return hit.paths;
  let paths;
  try {
    paths = await githubTree(owner, repo, opts);
  } catch (_) {
    paths = await jsdelivrTree(owner, repo, opts); // 官方接口限流/失败时才退到可能滞后的清单
  }
  if (!paths.length) throw new Error(`拿不到 ${owner}/${repo} 的文件清单`);
  if (treeCache.size >= TREE_CACHE_MAX) treeCache.clear();
  treeCache.set(key, { paths, t: Date.now() });
  return paths;
}

/**
 * 在仓库路径里定位 SKILL 目录：目录名与 skillId 同名，层级最浅的优先
 * （skills/engineering/tdd 胜过 a/b/c/tdd）。仓库根的 SKILL.md 只在 skillId
 * 与仓库同名时才算命中 —— 否则「根目录 SKILL.md」会把任何 skillId 都吸过去。
 * 找不到返回 null（区别于「就是仓库根」的空串）。
 */
function findSkillDir(paths, skillId, repo) {
  const want = String(skillId || '')
    .trim()
    .toLowerCase();
  if (!want) return null;
  const hits = [];
  for (const p of paths) {
    const m = /^(?:(.*)\/)?SKILL\.md$/i.exec(p);
    if (!m) continue;
    const dir = m[1] || '';
    const base = dir ? dir.split('/').pop().toLowerCase() : '';
    if (base === want) hits.push(dir);
  }
  if (!hits.length) return want === String(repo || '').toLowerCase() ? '' : null;
  hits.sort((a, b) => a.split('/').filter(Boolean).length - b.split('/').filter(Boolean).length);
  return hits[0];
}

/** 目录下的文件清单（相对仓库根） */
function filesUnder(paths, dir) {
  const prefix = dir ? dir + '/' : '';
  return paths.filter((p) => p.startsWith(prefix) && p.length > prefix.length);
}

const skillKey = (owner, repo, id) => `${owner}/${repo}/${id || ''}`;

function skillCacheGet(key) {
  const hit = skillCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.t > SKILL_TTL) {
    skillCache.delete(key);
    return null;
  }
  return hit;
}

function skillCacheSet(key, value) {
  if (skillCache.size >= SKILL_CACHE_MAX) skillCache.clear();
  skillCache.set(key, { ...value, t: Date.now() });
}

/** 内容源竞速：同一文件四个源并发取，谁先到用谁。
    首个成功源记为「首选」——之后的请求直取首选源，一次成功零浪费；
    首选失败（或熔断）就重新竞速。健康网络自动锁进官方接口，
    raw/CDN 被墙的网络自动锁进代理源，全程不需要用户配任何东西。 */
const GHPROXY_RAW = 'https://ghproxy.net/https://raw.githubusercontent.com';
const CONTENT_SOURCES = ['contents', 'cdn', 'ghproxy', 'raw'];
let preferredContent = '';

/** 单源取一个文件，返回 Buffer。contents 撞限流记入 limited 标记。 */
async function fetchVia(src, owner, repo, relPath, { token, fetcher = httpGet } = {}) {
  if (src === 'contents') {
    const apiUrl = `${GITHUB_API}/repos/${owner}/${repo}/contents/${relPath.split('/').map(encodeURIComponent).join('/')}`;
    const data = await fetcher(apiUrl, { headers: ghHeaders(token, apiUrl), expectJson: true, timeoutMs: 10000 });
    if (data && typeof data.content === 'string' && data.encoding === 'base64') {
      return Buffer.from(data.content.replace(/\s+/g, ''), 'base64');
    }
    throw new Error('contents 无内联内容');
  }
  let url;
  if (src === 'cdn') url = `${JSDELIVR_CDN}/${owner}/${repo}@HEAD/${relPath}`;
  else if (src === 'ghproxy') url = `${GHPROXY_RAW}/${owner}/${repo}/HEAD/${relPath}`;
  else url = `${GITHUB_RAW}/${owner}/${repo}/HEAD/${relPath}`;
  // ghproxy 是第三方代理：token 纪律照旧 —— ghHeaders 只认 GitHub 域名，token 绝不出境
  const res = await fetcher(url, { headers: ghHeaders(token, url), timeoutMs: 6000 });
  return Buffer.from(typeof res === 'string' ? res : await res.arrayBuffer());
}

async function readRawBytes(owner, repo, relPath, { token, fetcher = httpGet } = {}) {
  const rel = String(relPath || '').replace(/^\/+/, '');
  // 首选源直取：一次成功，不再全源竞速
  if (preferredContent && !sourceDead(preferredContent)) {
    try {
      return await fetchVia(preferredContent, owner, repo, rel, { token, fetcher });
    } catch (err) {
      markSource(preferredContent, err);
      // 限流（403/429）与连接故障都说明首选源眼下靠不住：清掉记忆，跌回竞速重选
      if (/HTTP (429|403)/.test(String((err && err.message) || err))) preferredContent = '';
      if (isConnError(err)) preferredContent = '';
    }
  }
  // 存活源竞速：第一个成功者胜出（Promise.any），失败源各自进熔断
  const rest = CONTENT_SOURCES.filter((s) => s !== preferredContent && !sourceDead(s));
  if (!rest.length) throw new Error('读取失败：' + rel);
  const losers = [];
  const attempts = rest.map((src) =>
    fetchVia(src, owner, repo, rel, { token, fetcher })
      .then((buf) => {
        preferredContent = src;
        return buf;
      })
      .catch((err) => {
        markSource(src, err);
        losers.push(err);
        throw err;
      })
  );
  try {
    return await Promise.any(attempts);
  } catch (aggErr) {
    // 原始错误挂 cause：排查时能看到每个源各自败在哪，而不是只有一句汇总
    throw new Error('读取失败：' + rel, { cause: aggErr });
  }
}

/** 连接级失败的熔断：某个源连不上（超时/网络错误）就停用一段时间，
    别让后面的每个文件都陪跑一次注定失败的超时 —— 限流 + raw 不可达时这里能省几十秒。
    HTTP 404 是「文件不存在」，不算源故障，不熔断。 */
const SOURCE_COOLDOWN = 10 * 60 * 1000;
const sourceHealth = { contents: 0, cdn: 0, raw: 0, ghproxy: 0 };
const isConnError = (err) => {
  const s = String((err && err.message) || err);
  return !/HTTP \d{3}/.test(s);
};
const sourceDead = (k) => Date.now() < sourceHealth[k];
const markSource = (k, err) => {
  if (isConnError(err)) sourceHealth[k] = Date.now() + SOURCE_COOLDOWN;
};

/** 仅供测试：清掉源熔断与首选源记忆，避免测试间互相污染 */
function resetSourceHealth() {
  sourceHealth.contents = 0;
  sourceHealth.cdn = 0;
  sourceHealth.raw = 0;
  sourceHealth.ghproxy = 0;
  preferredContent = '';
}

/** 读一个仓库文件的文本；全都失败返回 null —— 市场列表宁可少个描述，也不能整页报错 */
async function readRaw(owner, repo, relPath, opts = {}) {
  try {
    return (await readRawBytes(owner, repo, relPath, opts)).toString('utf8');
  } catch (_) {
    return null;
  }
}

/**
 * 解析一条市场条目 → { description, path }。
 * path 是 SKILL 目录（'' 表示仓库根），拿不到就是 null。全程不抛。
 */
async function resolveEntry(item, { token, fetcher = httpGet } = {}) {
  const s = (item && item.source) || {};
  if (s.kind !== 'github' || !s.owner || !s.repo) return { description: '', path: null };
  const id = (item.meta && item.meta.skillId) || item.name || '';
  const key = skillKey(s.owner, s.repo, id);
  const cached = skillCacheGet(key);
  if (cached) return cached;

  // 索引/SkillsMP 的条目自带路径，直接用，不必再拉树
  let dir = typeof s.path === 'string' && s.path ? s.path : null;
  if (dir === null) {
    try {
      dir = findSkillDir(await repoTree(s.owner, s.repo, { token, fetcher }), id, s.repo);
    } catch (_) {
      dir = null; // 限流 / 断网：退化成「不知道路径」，描述留空
    }
  }
  let description = '';
  let textOk = false;
  if (dir !== null) {
    const text = await readRaw(s.owner, s.repo, (dir ? dir + '/' : '') + 'SKILL.md', { token, fetcher });
    if (text !== null) {
      textOk = true;
      const parsed = parseFrontmatter(text);
      description = (parsed.meta && parsed.meta.description) || firstParagraph(parsed.body) || '';
    }
  }
  const out = { description, path: dir };
  // 树拉不到（多半是限流）或正文读失败都不写缓存：免得把「没网」记成 24 小时的「没描述」
  if (dir !== null && textOk) skillCacheSet(key, out);
  return out;
}

/**
 * 批量解析（与入参对齐）。描述与目录在检索时就补全，列表一次画完 —— 不再先出骨架
 * 再几秒后回填。并发 6，单条失败只影响它自己。
 */
async function resolveEntries(items, opts = {}) {
  const list = Array.isArray(items) ? items : [];
  const out = new Array(list.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(6, list.length) }, async () => {
    while (cursor < list.length) {
      const i = cursor++;
      try {
        out[i] = await resolveEntry(list[i], opts);
      } catch (_) {
        out[i] = { description: '', path: null };
      }
    }
  });
  await Promise.all(workers);
  return out;
}

/** 详情：描述 + SKILL.md 正文 + 该目录下的文件清单（详情弹窗一次拿齐）。
    结果缓存 30 分钟：反复开关同一个详情不再打网络。网络差（raw 不可达 / 配额耗尽）
    时正文走不了 raw 链路，退化成整仓 zip（codeload，无配额）里读 —— 详情不该比安装更脆。 */
const DETAIL_TTL = 30 * 60 * 1000;
const detailCache = new Map(); // owner/repo/skillId → { r, t }
// 条目里带 SKILL.md 全文，比其他缓存重得多：必须封顶，别让反复逛详情悄悄吃内存
const DETAIL_CACHE_MAX = 200;

async function skillDetail({ owner, repo, skillId, path: knownPath } = {}, { token, fetcher = httpGet } = {}) {
  if (!owner || !repo) throw new Error('缺少仓库信息');
  const key = `${owner}/${repo}/${skillId || knownPath || ''}`;
  const hit = detailCache.get(key);
  if (hit && Date.now() - hit.t < DETAIL_TTL) return hit.r;
  try {
    const r = await skillDetailInner({ owner, repo, skillId, path: knownPath }, { token, fetcher });
    if (detailCache.size >= DETAIL_CACHE_MAX) detailCache.clear();
    detailCache.set(key, { r, t: Date.now() });
    return r;
  } catch (err) {
    // 「仓库里没有这个 SKILL」是确定性答案，不是网络问题，别去下整仓兜底
    if (err && err.noFallback) throw err;
    // 兜底也失败时抛原始错误：它才是根因（限流 / raw 不可达），兜底错误只是表象
    try {
      const r = await skillDetailFromZip({ owner, repo, skillId, path: knownPath }, { token });
      if (detailCache.size >= DETAIL_CACHE_MAX) detailCache.clear();
      detailCache.set(key, { r, t: Date.now() });
      return r;
    } catch (e) {
      e.cause = err;
      throw e;
    }
  }
}

/** 正路：树定位 + raw 链路读正文 */
async function skillDetailInner({ owner, repo, skillId, path: knownPath } = {}, { token, fetcher = httpGet } = {}) {
  const paths = await repoTree(owner, repo, { token, fetcher });
  const dir = typeof knownPath === 'string' && knownPath ? knownPath : findSkillDir(paths, skillId, repo);
  if (dir === null) {
    const err = new Error('在这个仓库里没有找到对应的 SKILL 目录');
    err.noFallback = true;
    throw err;
  }
  const files = filesUnder(paths, dir);
  const mdPath = (dir ? dir + '/' : '') + 'SKILL.md';
  const text = await readRaw(owner, repo, mdPath, { token, fetcher });
  if (text === null) throw new Error('读取 SKILL.md 失败');
  const parsed = parseFrontmatter(text);
  return {
    ok: true,
    path: dir,
    description: (parsed.meta && parsed.meta.description) || firstParagraph(parsed.body) || '',
    body: parsed.body,
    files,
    skillMd: mdPath,
  };
}

/** 兜底：整仓 zip（codeload，不走 API 配额也不走 raw），解压后在本地认回目标 SKILL。
    认回规则与渲染层安装回退一致：目录名同名 > frontmatter 名（排除仓库根）> 唯一 SKILL。 */
async function skillDetailFromZip({ owner, repo, skillId, path: knownPath } = {}, { token } = {}) {
  const dir = typeof knownPath === 'string' && knownPath ? knownPath : '';
  const r = await inspectSource({ kind: 'github', owner, repo, ref: '', path: dir }, { token });
  if (!r.ok) throw new Error('读取 SKILL.md 失败（整仓兜底也不可用）：' + (r.error || ''));
  const cands = r.skills || [];
  const dirName = dir ? dir.split('/').filter(Boolean).pop() : '';
  const base = (s) =>
    String(s.relPath || '')
      .split('/')
      .filter(Boolean)
      .pop() || '';
  const byDir = dirName ? cands.filter((s) => base(s) === dirName) : [];
  const byName = skillId ? cands.filter((s) => s.name === skillId && s.relPath) : [];
  const hit = byDir[0] || byName[0] || (cands.length === 1 ? cands[0] : null);
  if (!hit) throw new Error('整仓里没有找到这个 SKILL');
  const parsed = parseFrontmatter(fs.readFileSync(hit.skillMdPath, 'utf8'));
  // 文件清单就地遍历临时目录，相对路径与正路返回的形状一致
  const rootRel = hit.absPath;
  const files = [];
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else files.push(path.relative(rootRel, p).split(path.sep).join('/'));
    }
  };
  walk(rootRel);
  return {
    ok: true,
    path: hit.relPath || '',
    description: (parsed.meta && parsed.meta.description) || firstParagraph(parsed.body) || '',
    body: parsed.body,
    files,
    skillMd: (dir ? dir + '/' : '') + 'SKILL.md',
  };
}

/**
 * 只取回单个 SKILL：按 tree 里的文件清单逐个从 raw 下载到临时目录。
 * 这是「点安装要等整仓 zip」的解药 —— 大仓库也只下这一个目录的几十 KB。
 * 返回的 dir 交给渲染层走既有的 skill:copy，与整仓流程共用同一段安装代码。
 */
async function fetchSkillFiles({ owner, repo, path: dir } = {}, { token, fetcher = httpGet } = {}) {
  if (!owner || !repo) throw new Error('缺少仓库信息');
  const paths = await repoTree(owner, repo, { token, fetcher });
  const files = filesUnder(paths, typeof dir === 'string' ? dir : '');
  if (!files.length) throw new Error('这个 SKILL 目录里没有文件');
  if (files.length > MAX_SKILL_FILES) throw new Error(`文件太多（${files.length} 个），改用整仓取回`);

  const root = path.join(tempDir(), 'cc-skill-fetch-' + Date.now());
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const base = dir ? dir + '/' : '';

  let cursor = 0;
  const workers = Array.from({ length: Math.min(4, files.length) }, async () => {
    while (cursor < files.length) {
      const rel = files[cursor++];
      // 按字节写：SKILL 里可能带图片等二进制文件，走 text() 会把它写坏
      const buf = await readRawBytes(owner, repo, rel, { token, fetcher });
      const dest = path.join(root, ...rel.slice(base.length).split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
    }
  });
  await Promise.all(workers);
  return { ok: true, dir: root, files: files.map((f) => f.slice(base.length)), label: `${owner}/${repo}${dir ? '/' + dir : ''}` };
}

/** 仓库 owner 的头像（GitHub 官方头像 CDN）。渲染层的 CSP 只放行 data:，
    所以在主进程取回后转成 data URL —— 顺带也走了应用配置的代理 */
const avatarCache = new Map();
async function ownerAvatar({ owner } = {}, { fetcher = httpGet } = {}) {
  const name = String(owner || '').trim();
  if (!name) return { ok: false };
  const hit = avatarCache.get(name);
  if (hit) return hit;
  const url = `https://github.com/${encodeURIComponent(name)}.png?size=80`;
  let out = { ok: false };
  try {
    const res = await fetcher(url, { timeoutMs: 6000 });
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length) {
      const type = (res.headers && res.headers.get && res.headers.get('content-type')) || 'image/png';
      out = { ok: true, dataUrl: `data:${type};base64,${buf.toString('base64')}` };
    }
  } catch (_) {
    /* 头像拿不到就用首字母图标，不值得报错 */
  }
  // 只缓存成功结果：失败多半是网络抖动（比如 github.com 直连被断），负缓存会把
  // 失败粘住整个运行期——网络恢复后头像也永远出不来，只能重启应用
  if (!out.ok) return out;
  if (avatarCache.size >= 300) avatarCache.clear();
  avatarCache.set(name, out);
  return out;
}

// ------------------------------ 聚合检索 searchAll ----------------------------
// 一个搜索框一次请求：来源并行、各带预算、谁挂了列表照常出。渲染层从此只认
// 统一条目形状（kind: skill/repo/zip），不再知道任何市场 URL。
const INDEX_TTL = 10 * 60 * 1000;
const indexCache = new Map(); // url → { r, t }

/** 自定义索引缓存：索引不常变，别每次检索都重新拉一遍（首次后零开销） */
async function fetchIndexCached(url, { token, budgetMs = SEARCH_BUDGET_MS } = {}) {
  const key = String(url || '').trim();
  for (const [k, v] of indexCache) {
    if (Date.now() - v.t > INDEX_TTL) indexCache.delete(k);
  }
  const hit = indexCache.get(key);
  if (hit) return hit.r;
  const r = await withBudget(fetchIndex(url, { token }), budgetMs, '自定义索引');
  if (r && r.ok) {
    if (indexCache.size >= 20) indexCache.clear();
    indexCache.set(key, { r, t: Date.now() });
  }
  return r;
}

/** 仓库模式详情：列出仓库里的全部 SKILL（树定位 + 描述解析），弹窗里挑一个看正文再装。
    仓库根的 SKILL.md（dir ''）也计入 —— 「仓库本身就是个 SKILL」的布局同样成立。 */
async function repoSkills({ owner, repo } = {}, { token } = {}) {
  if (!owner || !repo) throw new Error('缺少仓库信息');
  const paths = await repoTree(owner, repo, { token });
  const dirs = [];
  for (const p of paths) {
    if (p === 'SKILL.md') dirs.push('');
    else if (p.endsWith('/SKILL.md')) dirs.push(p.slice(0, -'/SKILL.md'.length));
  }
  const shown = dirs.slice(0, 20);
  const items = shown.map((dir) => ({
    source: { kind: 'github', owner, repo, path: dir },
    meta: { skillId: dir ? dir.split('/').pop() : repo },
  }));
  const resolved = await resolveEntries(items, { token });
  return {
    ok: true,
    total: dirs.length,
    skills: items.map((it, i) => {
      const r = resolved[i] || {};
      return { path: it.source.path, name: it.meta.skillId, description: r.description || '' };
    }),
  };
}

/** 归一成统一条目形状：列表/详情/安装只认这一种。source 保留原始来源描述
    （github/zip），mkInspect 与「在 GitHub 查看」还靠它工作。 */
function toUnified(it, srcId, srcName) {
  const s = (it && it.source) || {};
  if (s.kind === 'zip') {
    return { kind: 'zip', name: it.name, description: it.description || '', tags: it.tags || [], srcId, srcName, source: s };
  }
  const meta = it.meta || {};
  return {
    kind: 'skill',
    name: it.name,
    description: it.description || '',
    owner: s.owner || '',
    repo: s.repo || '',
    skillId: meta.skillId || '',
    path: s.path || '',
    ref: s.ref || '',
    installs: meta.installs || 0,
    stars: meta.stars || 0,
    tags: it.tags || [],
    srcId,
    srcName,
    source: s,
  };
}

function toUnifiedRepo(r) {
  return {
    kind: 'repo',
    name: r.fullName,
    description: r.description || '',
    stars: r.stars || 0,
    owner: r.owner || '',
    repo: r.repo || '',
    srcId: 'github',
    srcName: 'GitHub',
    source: { kind: 'github', owner: r.owner || '', repo: r.repo || '', ref: '', path: '' },
  };
}

/** 聚合检索：无关键词 = 热门（各站注册的 featured 查询词），有关键词 = 全来源并行检索。
    返回统一条目 + 每来源小结（谁成功几个、谁没返回），渲染层据此拼状态行。 */
async function searchAll(q, { token, indexUrl, budgetMs = SEARCH_BUDGET_MS, category = '', sortBy = 'popular', page = 1 } = {}) {
  const query = String(q || '').trim();
  const featured = !query;
  const feat = (id, fallback) => {
    const m = BUILTIN_MARKETS.find((x) => x.id === id);
    return m && m.featured ? m.featured.query : fallback;
  };
  const runSource = async (id, name, fn) => {
    const s = { id, name, ok: false, count: 0, error: '' };
    try {
      const r = await fn();
      if (r && r.ok) {
        s.ok = true;
        s.count = (r.items || []).length;
      } else {
        s.error = (r && r.error) || '失败';
      }
      return [s, (r && r.items) || [], r || {}];
    } catch (e) {
      s.error = String((e && e.message) || e);
      return [s, [], {}];
    }
  };

  const jobs = [];
  if (category) {
    // 分类浏览只走 SkillHub 目录：其他来源没有分类概念，混进来反而杂
    jobs.push(runSource('skillhub', 'SkillHub', () => searchSkillhub('', { budgetMs, category, sortBy, page })));
  } else {
    // SkillHub 排在最前：整页条目自带描述/星标，行最完整；其余来源补量与装机量。
    // skills.sh 不支持服务端分页：整表缓存在主进程，按页切片，翻页不再空手而回
    jobs.push(runSource('skillhub', 'SkillHub', () => searchSkillhub(featured ? '' : query, { budgetMs, sortBy, page })));
    jobs.push(runSource('skills-sh', 'skills.sh', () => searchSkillsSh(featured ? feat('skills-sh', 'skill') : query, { budgetMs, page })));
    // SkillsMP 不是 GitHub 域：token 纪律要求这里绝不带 token，搜索接口也不需要
    jobs.push(runSource('skillsmp', 'SkillsMP', () => searchSkillsMp(featured ? feat('skillsmp', 'agent') : query, { budgetMs, page })));
    if (query) jobs.push(runSource('github', 'GitHub', () => searchGithub(query, { token, budgetMs, page })));
    if (indexUrl) jobs.push(runSource('custom', '自定义索引', () => fetchIndexCached(indexUrl, { token, budgetMs })));
  }

  const results = await Promise.all(jobs);

  // 归一 + 去重：SKILL 条目按 owner/repo + 路径（或 skillId）识别同一技能；仓库条目
  // 若与某个 SKILL 条目同仓则不重复展示 —— 那个 SKILL 的详情弹窗里能看到全仓清单。
  const skills = [];
  const repos = [];
  const seenSkill = new Set();
  const seenRepo = new Set();
  const skillRepos = new Set();
  const sources = [];
  for (const [s, rawItems, r] of results) {
    if (s.id === 'custom' && r && r.name) s.name = r.name;
    sources.push(s);
    for (const raw of rawItems) {
      if (!raw) continue;
      const u = raw.source ? toUnified(raw, s.id, s.name) : toUnifiedRepo(raw);
      if (u.kind === 'repo') {
        const k = u.owner + '/' + u.repo;
        if (seenRepo.has(k)) continue;
        seenRepo.add(k);
        repos.push(u);
      } else {
        const k = u.owner + '/' + u.repo + '|' + (u.path || u.skillId || u.name);
        if (seenSkill.has(k)) continue;
        seenSkill.add(k);
        if (u.owner && u.repo) skillRepos.add(u.owner + '/' + u.repo);
        skills.push(u);
      }
    }
  }
  // 排序：默认（热门）按装机量从多到少——用户扫列表就是在找最多人用的那个；
  // 显式选了星标/名称就尊重用户的选择；「最新」没有统一的时间字段，保持来源自身顺序。
  if (sortBy === 'popular') skills.sort((a, b) => (b.installs || 0) - (a.installs || 0) || (b.stars || 0) - (a.stars || 0));
  else if (sortBy === 'stars') skills.sort((a, b) => (b.stars || 0) - (a.stars || 0) || (b.installs || 0) - (a.installs || 0));
  else if (sortBy === 'name') skills.sort((a, b) => String(a.name).localeCompare(String(b.name), 'en', { sensitivity: 'base' }));
  repos.sort((a, b) => (b.stars || 0) - (a.stars || 0));
  const items = [...skills, ...repos.filter((r) => !skillRepos.has(r.owner + '/' + r.repo))];
  const limited = results.some(([, , r]) => r && r.limited);
  const partial = results.some(([, , r]) => r && r.partial);
  return { ok: true, items, sources, limited, partial };
}

const BUILTIN_MARKETS = [
  {
    id: 'skills-sh',
    name: 'skills.sh',
    home: 'www.skills.sh',
    desc: 'Vercel 的 SKILL 目录，按装机量排序',
    search: searchSkillsSh,
    // 接口必须带 ≥2 字符的关键词，没有「无关键词的榜单」；热门区用挑好的宽泛查询，
    // tags 是页面上的一排快捷标签，点一下就按那个词检索
    featured: { query: 'skill', tags: ['code review', 'commit', 'pdf', 'frontend', 'testing', 'docs', 'python', 'data'] },
  },
  {
    id: 'skillsmp',
    name: 'SkillsMP',
    home: 'skillsmp.com',
    desc: 'Skills Marketplace，中英双语社区，按 star 排序',
    search: searchSkillsMp,
    featured: { query: 'agent', tags: ['agent', 'claude', 'codex', 'devops', 'writing', 'data', 'image'] },
  },
];

function listBuiltinMarkets() {
  return BUILTIN_MARKETS.map(({ id, name, home, desc, featured }) => ({ id, name, home, desc, featured }));
}

async function searchBuiltin(id, q, opts) {
  const m = BUILTIN_MARKETS.find((x) => x.id === id);
  if (!m) throw new Error('未知的内置市场：' + id);
  return m.search(q, opts);
}

module.exports = {
  parseRepoRef,
  parseSource,
  searchGithub,
  fetchIndex,
  normalizeIndexEntry,
  inspectSource,
  listSkillDirs,
  listBuiltinMarkets,
  searchBuiltin,
  searchAll,
  searchSkillhub,
  parseSkillhubRepoUrl,
  repoSkills,
  fetchIndexCached,
  resetSourceHealth,
  repoTree,
  jsdelivrTree,
  githubTree,
  findSkillDir,
  readRawBytes,
  resolveEntry,
  resolveEntries,
  skillDetail,
  fetchSkillFiles,
  ownerAvatar,
};
