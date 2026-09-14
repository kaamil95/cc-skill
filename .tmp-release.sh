TOKEN=$(printf "protocol=https\nhost=github.com\n\n" | GIT_TERMINAL_PROMPT=0 git credential fill 2>/dev/null | grep '^password=' | cut -d= -f2-)
PROXY=http://127.0.0.1:7897
API=https://api.github.com/repos/kaamil95/cc-skill

cat > /tmp/release-body.json <<'EOF'
{
  "tag_name": "v0.0.1",
  "target_commitish": "main",
  "name": "CC Skill v0.0.1 — 首个公开版本",
  "body": "CC Skill 的第一个公开版本。\n\n## 功能一览\n\n- **统一扫描**：Claude Code / Codex / OpenClaw / ZCode / Qoder 目录 + 共享目录 `~/.agents/skills`，支持平铺单文件 SKILL\n- **随处安装**：复制副本或 NTFS 目录联接（junction）——一份实体，多 Agent 即时共享\n- **合并重复**：识别散落各处的同名 SKILL（含全局/项目跨范围），收敛为「1 份唯一副本 + N 个链接」，项目目录用内容覆盖同步（Git 安全）\n- **项目级管理**：登记项目目录，全局 ⇄ 项目双向安装\n- **总览仪表盘**：统计磁贴、Agent / 项目分布、最近动态\n- **WebDAV 备份 / 恢复**：支持坚果云、Nextcloud、Alist 等；自动备份（启动 / 每天 / 每周，内容哈希免重传，云端保留最近 10 份）\n- **配置导入导出**：文件 + WebDAV 多设备同步（Agents / 项目 / WebDAV 配置）\n- **操作日志**：应用内面板 + 磁盘日志；删除一律进回收站\n\n## 下载\n\n附件 `CC Skill 0.0.1.exe` 为免安装便携版（Windows 10+）。\n\n## 说明\n\n- 首次运行会自动扫描各 Agent 目录；自定义 Agent 与项目在「设置」中配置\n- 链接安装依赖 NTFS；项目目录（Git 仓库）内一律使用副本安装\n- 欢迎提 Issue 与 PR 🙌"
}
EOF

echo "== 创建 Release =="
RESP=$(curl -s -x $PROXY -X POST -H "Authorization: token $TOKEN" -H "Accept: application/vnd.github+json" -d @/tmp/release-body.json $API/releases)
REL_ID=$(node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);console.log(j.id||'ERR:'+j.message)}catch(e){console.log('ERR:'+d.slice(0,200))}})" <<< "$RESP")
echo "release id: $REL_ID"

if [ "$REL_ID" != "ERR:"* ] && [ -n "$REL_ID" ] && [ "$REL_ID" != "ERR:"* ]; then
  UPLOAD_URL=$(node -e "const j=JSON.parse(process.argv[1]);console.log(j.upload_url||'')" <<< "$RESP" | sed 's/{.*//')
  echo "== 上传 exe 附件（96MB，走代理稍慢）=="
  curl -s -x $PROXY -X POST -H "Authorization: token $TOKEN" -H "Content-Type: application/octet-stream" \
    --data-binary @"dist/CC Skill 0.0.1.exe" "$UPLOAD_URL?name=CC.Skill.0.0.1.exe" -o /tmp/asset-res.json
  node -e "const j=JSON.parse(require('fs').readFileSync('/tmp/asset-res.json','utf8'));console.log('asset:', j.name || j.message, j.state||'')"
fi

echo "== 仓库信息 =="
curl -s -x $PROXY -X PATCH -H "Authorization: token $TOKEN" -H "Accept: application/vnd.github+json" \
  -d '{"description":"Unified SKILL manager for AI agents (Claude Code / Codex / OpenClaw / ZCode / Qoder): junction-link sharing, dedupe merge, project scopes, WebDAV backup. 统一管理 AI Agent 的 SKILL","homepage":"https://github.com/kaamil95/cc-skill#readme","has_discussions":true}' \
  $API -o /tmp/repo-patch.json
curl -s -x $PROXY -X PUT -H "Authorization: token $TOKEN" -H "Accept: application/vnd.github+json" \
  -d '{"names":["electron","ai-agent","skills","claude-code","codex","openclaw","zcode","qoder","webdav","windows"]}' \
  $API/topics -o /tmp/topics-res.json
node -e "const j=JSON.parse(require('fs').readFileSync('/tmp/repo-patch.json','utf8'));console.log('repo:', j.html_url, '| discussions:', j.has_discussions, '| desc:', (j.description||'').slice(0,40)+'...')"
node -e "const j=JSON.parse(require('fs').readFileSync('/tmp/topics-res.json','utf8'));console.log('topics:', (j.names||j.message||[]).join(', '))"
