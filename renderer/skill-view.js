// skill-view.js —— 卡片与详情共用的展示模型：一个 SKILL 挂在某个 Agent 名下时，
// 到底是「文件就在那儿」还是「只是链过去的一份引用」。
//
// 为什么值得单独成文件：扫描结果里每一条记录是一个磁盘目录，而界面上每张卡片是
// 「一份实体 + 指向它的若干链接」折叠出来的。所以「这个 Agent 是实体还是链接」不是
// 一个字段，得从 agentIds / links 的关系里推出来 —— 推理写错了界面不会报错，只会
// 静静地标反。和 theme.js 一样暴露到 window 上，便于用单测盯住。
(function () {
  /**
   * 只通过链接出现在这些 Agent 名下的 id。
   *
   * - 同一个 Agent 既有实体又有链接时以实体为准：实体那格才是文件真正所在。
   * - 这条记录本身就是链接时（唯一副本不在扫描范围内），它名下的所有 Agent 都是链接 ——
   *   文件确实不在这里。
   */
  function linkOnlyAgentIds(s) {
    const physical = s.linked ? new Set() : new Set(s.agentIds || []);
    const all = [...(s.agentIds || []), ...(s.links || []).flatMap((l) => l.agentIds || [])];
    return new Set(all.filter((id) => !physical.has(id)));
  }

  /**
   * 卡片该打哪种标记：
   *   dangling  失效链接，源已被删除或移动
   *   link      这一条本身就是链接，文件在别处
   *   canon     实体副本，且另有 N 个链接共用它
   *   copy      普通副本，没有链接牵扯 —— 不打标记，避免满屏都是徽章
   */
  function linkRole(s) {
    if (s.dangling) return 'dangling';
    if (s.linked) return 'link';
    if (s.linkCount) return 'canon';
    return 'copy';
  }

  /**
   * 当前筛选下，这张卡代表哪一条磁盘记录。
   *
   * 一张卡是「1 份实体 + N 个链接」折叠出来的，但列表标题写着「<Agent> 的 SKILL」——
   * 在某个 Agent 的视图里，卡片就该说这个 Agent 目录里是什么。那个 Agent 名下是链接，
   * 卡片就呈现成链接（徽章、竖标、路径都跟着变），删除也只删这一条，不会连带把
   * 别人共用的实体删掉。
   *
   * 「全部 SKILL」/ 项目 / 总览没有 Agent 上下文，呈现实体记录本身。
   * 同一个 Agent 名下既有实体又有链接时实体优先 —— 文件确实在那儿。
   */
  function viewedEntry(s, filter) {
    if (!filter || filter === 'dashboard' || String(filter).startsWith('project:')) return s;
    if ((s.agentIds || []).includes(filter)) return s;
    return (s.links || []).find((l) => (l.agentIds || []).includes(filter)) || s;
  }

  window.skillView = { linkOnlyAgentIds, linkRole, viewedEntry };
})();
