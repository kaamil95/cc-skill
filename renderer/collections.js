// collections.js —— 虚拟分组的成员解析：config 里一条 {dir, folder} 记录，
// 到底对应界面上的哪张卡片。
//
// 为什么值得单独成文件：分组成员存的是「目录（~ 形式）+ 文件夹名」这个可移植身份，
// 跨机器恢复后 dir 可能对不上，得有第二级「按 folder 名唯一回填」兜着。解析错了
// 界面不会报错，只会静默少卡 / 错卡 —— 和 skill-view.js 一样，靠单测盯住。
// 暴露到 window 上便于用最小 window 桩在 node 里跑。
(function () {
  // 与 app.js 的 normPath 同构：统一分隔符、去掉尾斜杠、大小写不敏感 ——
  // Windows 上 C:\a\b 与 C:/a/B 是同一个目录
  function normPath(p) {
    return String(p || '')
      .replace(/[\\/]+/g, '/')
      .replace(/\/+$/, '')
      .toLowerCase();
  }

  // 一张卡物理上可能落在的目录：本体目录 + 它所有链接的所在目录。
  // 链接卡本身记自己的 parentDir —— 本体不在扫描范围内时（项目里指向仓库外的链接），
  // 它是分组里唯一能找到的落点
  function entryDirs(s) {
    const dirs = new Set();
    if (s.parentDir) dirs.add(normPath(s.parentDir));
    for (const l of s.links || []) if (l.parentDir) dirs.add(normPath(l.parentDir));
    return dirs;
  }

  // 精确匹配：item 的目录（~ 形式展开后）+ 文件夹名 对上卡片的某个落点
  function itemMatches(item, s, expandFn) {
    if (!item || item.folder !== s.folder) return false;
    return entryDirs(s).has(normPath(expandFn(item.dir)));
  }

  /**
   * 解析一个分组的成员。返回：
   *   cards    Set(卡片 key) —— 命中的卡片（一般是本体；本体不在扫描范围内的纯链接卡
   *            以链接自身的 key 计入）
   *   dangling 失配的 item 数组 —— 精确、回填、纯链接三级都没对上的，界面不显示
   *
   * 三级匹配：
   *   ① dir+folder 精确命中本体（本机日常路径，绝大多数走这条）
   *   ② 精确失配按 folder 名在本体列表里找，**唯一**命中才认 ——
   *     跨机器恢复时目录变了但名字还在，就有救；两个以上同名（多个项目各有 deploy）
   *     宁缺勿滥，免得收藏夹静默收错东西
   *   ③ 还没有命中的，按目录精确匹配**纯链接卡**（本体没被扫描到、如项目里指向仓库
   *     外部的 junction）—— 不收的话这类卡永远进不了分组
   */
  function resolveCollection(view, items, expandFn) {
    const canon = (view || []).filter((s) => !s.linked);
    const links = (view || []).filter((s) => s.linked);
    const cards = new Set();
    const pending = [];
    for (const item of items || []) {
      const hit = canon.find((s) => itemMatches(item, s, expandFn));
      if (hit) cards.add(hit.key);
      else pending.push(item);
    }
    const dangling = [];
    for (const item of pending) {
      // 精确优先于启发式：先认链接卡的落点，再退回名称回填
      const linkHit = links.find((s) => itemMatches(item, s, expandFn));
      if (linkHit) {
        cards.add(linkHit.key);
        continue;
      }
      const hits = canon.filter((s) => s.folder === item.folder);
      if (hits.length === 1) cards.add(hits[0].key);
      else dangling.push(item);
    }
    return { cards, dangling };
  }

  /**
   * 全部分组的成员归属，一次算完给渲染层用：卡片 key -> [{id, name}]。
   * 卡片上的分组徽章与「分组」弹窗的勾选态都从这里来，别各自再扫一遍。
   */
  function membershipsFor(view, collections, expandFn) {
    const map = new Map();
    for (const col of collections || []) {
      const { cards } = resolveCollection(view, col.items, expandFn);
      for (const k of cards) {
        if (!map.has(k)) map.set(k, []);
        map.get(k).push({ id: col.id, name: col.name });
      }
    }
    // 传播到链接卡：项目视图里卡片是链接条目（key 不是本体 key），
    // 不传播的话项目视图既没有徽章也不折叠
    for (const s of view || []) {
      const list = map.get(s.key);
      if (!list) continue;
      for (const l of s.links || []) if (!map.has(l.key)) map.set(l.key, list);
    }
    return map;
  }

  /**
   * 一键收纳的前缀候选：名字或文件夹名的第一段（- 或 _ 之前）出现 ≥ min 次才算高频，
   * wecomcli-doc / wecomcli-contact / … 这种家族式命名一抓一个准。计数与收纳时的匹配
   * 规则保持一致（名称或 folder 前缀），同一张卡只算一次。
   * 只看本体（链接卡与本体是同一个 SKILL）；前缀至少 3 个字符，避免「de」「sk」这类噪声。
   */
  function suggestPrefixes(view, min = 3) {
    const counts = new Map();
    for (const s of view || []) {
      if (s.linked) continue;
      const seenOnCard = new Set();
      for (const text of [s.name || '', s.folder || '']) {
        const m = /^([A-Za-z][\w-]*?)[-_]/.exec(text);
        if (!m || m[1].length < 3 || seenOnCard.has(m[1])) continue;
        seenOnCard.add(m[1]);
        counts.set(m[1], (counts.get(m[1]) || 0) + 1);
      }
    }
    return [...counts.entries()]
      .filter(([, n]) => n >= min)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([p, n]) => ({ prefix: p + '-', count: n }));
  }

  /**
   * 当前视图的作用域谓词：项目视图 = 该项目成员；全局 Agent 视图 = 该 Agent 名下
   *（不含项目卡）；总览 / 市场没有作用域，返回 null。
   * 折叠段、徽章、一键收纳共用这一道门，避免某条渲染路径漏掉作用域判断。
   */
  function inScopeFor(filter) {
    const f = String(filter || '');
    if (f.startsWith('project:')) {
      const pid = f.slice(8);
      return (s) => !!s.project && s.project.id === pid;
    }
    if (f === 'dashboard' || f === 'market') return null;
    return (s) => !s.project && (s.allAgentIds || []).includes(filter);
  }

  /** 当前视图可操作的分组：全局视图只见 global 组，项目视图只见本项目的组 */
  function collectionsInScope(collections, filter) {
    const scope = String(filter || '').startsWith('project:') ? String(filter) : 'global';
    return (collections || []).filter((c) => (c.scope || 'global') === scope);
  }

  /** 作用域内卡片 → 去重后的本体集（项目视图里多为链接卡，分组收的是本体 key） */
  function canonCardsInScope(view, filter) {
    const pred = inScopeFor(filter);
    if (!pred) return [];
    const canonByKey = new Map((view || []).filter((x) => !x.linked).map((x) => [x.absPath.toLowerCase(), x]));
    const seen = new Set();
    const out = [];
    for (const s of view || []) {
      if (!pred(s)) continue;
      const t = s.linked && s.linkTarget ? canonByKey.get(s.linkTarget.toLowerCase()) : s;
      if (!t || seen.has(t.key)) continue;
      seen.add(t.key);
      out.push(t);
    }
    return out;
  }

  window.skillCollections = {
    normPath,
    entryDirs,
    itemMatches,
    resolveCollection,
    membershipsFor,
    suggestPrefixes,
    inScopeFor,
    collectionsInScope,
    canonCardsInScope,
  };
})();
