#!/usr/bin/env bash
# T1-13 S5 · CLI 侧真机冒烟（真模型 + tmux，F1 纯 CLI 端到端 + AC-1.1/1.3 + 唯一真相）
#
# 复用 T1-10 tui-smoke.sh 手法：doc 会话六工具 → create_artifact → 只读三工具 →
# propose_edit → 汇总卡逐键确认 → 物化 v2 → 领域目录断言 → 临时 Web server 读同一
# 数据目录断言版本链（S5 期望③：CLI 与 Web 面板看到同一份——唯一真相 JSONL）。
#
# 出口判据证据映射：
#   AC-1.3（doc 模式无 write/edit）  --tools 六工具白名单 + smoke-probe.ts assembly.ready
#   AC-1.1（只读工具结构化结果）     tool_execution_start 留痕 + 汇总卡后 CLI 读侧复验
#   S5 期望③（同一份真相）           冒烟产物被临时 Web server API 读到（版本号/内容一致）
#   S5 期望④（受管路径直写硬挡）     引用 T1-10 独立验证（verifier 守卫 + 四类绕过变体），
#                                   本脚本不重复（真会话白名单内无写类工具，直写不可达）
#
# 可重复性：每次 rm -rf /tmp/t1-13-smoke 全量重建（T1-10 P3 教训：probe 建项目先清目录）。
# 留证：/tmp/t1-13-smoke/smoke.pane（每步 capture-pane）+ probe.log + 领域目录快照 + web-read.log
# 用法：bash e2e/cli-smoke.sh（DeepSeek key 从仓库根 .env.pi-test 读，仅注入进程环境）
set -u
WORK=/tmp/t1-13-smoke
HERE="$(cd "$(dirname "$0")" && pwd)"   # apps/web/e2e
ROOT="$(cd "$HERE/../../.." && pwd)"    # 仓库根（e2e → web → apps → 根）
PI_CLI="$ROOT/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
SESS="t1-13-smoke"
PANE_LOG="$WORK/smoke.pane"
TOOLS="create_artifact,propose_edit,list_artifacts,get_artifact_diff,list_my_artifacts,get_artifact_history"
WEB_PORT=8890

rm -rf "$WORK"
mkdir -p "$WORK"
cp "$(dirname "$0")/smoke-probe.ts" "$WORK/smoke-probe.ts"
: > "$PANE_LOG"

set -a
# shellcheck disable=SC1090
source <(grep -E '^DEEPSEEK_' "$ROOT/.env.pi-test")
set +a

tmux kill-session -t "$SESS" 2>/dev/null

pane() { tmux capture-pane -t "$SESS" -p; }
shot() { # $1 = 标注
  echo "===== [$1] $(date +%H:%M:%S) =====" >> "$PANE_LOG"
  pane >> "$PANE_LOG"
}
wait_for() { # $1 = grep 模式，$2 = 最长秒数
  for i in $(seq 1 "${2:-60}"); do
    if pane | grep -qE "$1"; then return 0; fi
    sleep 1
  done
  return 1
}

tmux new-session -d -s "$SESS" -x 110 -y 36 \
  "export DEEPSEEK_API_KEY='$DEEPSEEK_API_KEY' DEEPSEEK_BASE_URL='$DEEPSEEK_BASE_URL' DEEPSEEK_MODEL='$DEEPSEEK_MODEL'; cd $WORK && node $PI_CLI --extension $WORK/smoke-probe.ts --model deepseek/$DEEPSEEK_MODEL --no-session --no-context-files --no-skills --approve --tools $TOOLS 2>&1"
sleep 4
shot "pi 启动 4s"
wait_for '>|❯|┃' 30 || shot "启动超时"
sleep 2
shot "启动完成（能力层白名单 = --tools 六工具，物理无 write/edit/bash）"

# ---- 场景：建文档 → 只读三工具 → 提议修改 → 汇总卡确认 → 物化
tmux send-keys -t "$SESS" \
  "请先调用 create_artifact 创建一份受管设计文档（kind=design，title=冒烟文档，content 为：## 需求\n原始需求段落。）；创建完成后，依次调用 get_artifact_history、list_my_artifacts、get_artifact_diff 三个只读工具读取这份文档的信息（参数 id 用上一步返回的 id）；最后调用 propose_edit 对这份文档提议修改（把“原始需求段落。”改为“修改后的需求段落。”），参数 id 同样用第一步返回的 id。" Enter
sleep 2
wait_for '已决 0/' 120 || shot "汇总卡未出现"
shot "汇总卡初始帧"
tmux send-keys -t "$SESS" y 1
sleep 1
shot "按 y1（接受块1）"
tmux send-keys -t "$SESS" a
sleep 1
shot "按 a（全收）"
tmux send-keys -t "$SESS" Enter
sleep 2
wait_for '已确认并物化|v2' 90 || shot "未等到物化完成"
shot "场景结果帧"
sleep 3

# ---- 领域目录断言（物化 + 版本链 + pending 清理）----
echo "===== 领域目录证据 =====" >> "$PANE_LOG"
find "$WORK/nextstep/artifacts/managed" -type f 2>/dev/null | sort >> "$PANE_LOG"
echo "--- 物化文件内容（应含修改后的需求段落） ---" >> "$PANE_LOG"
cat "$WORK/冒烟文档.md" 2>/dev/null >> "$PANE_LOG"
echo "--- versions 快照（应 v1+v2，v2 note=apply pending、author=user） ---" >> "$PANE_LOG"
for f in "$WORK"/nextstep/artifacts/managed/*/versions/*.json; do
  [ -f "$f" ] && cat "$f" >> "$PANE_LOG"
done
echo "--- pending 目录（应为空） ---" >> "$PANE_LOG"
find "$WORK/nextstep/artifacts/managed" -type d -name pending 2>/dev/null >> "$PANE_LOG"

# ---- 探针断言：AC-1.3 白名单 + 只读工具调用留痕（AC-1.1）----
echo "===== probe.log 关键行 =====" >> "$PANE_LOG"
grep -E "assembly.ready|tool.call" "$WORK/probe.log" >> "$PANE_LOG" 2>/dev/null || echo "probe.log 缺失" >> "$PANE_LOG"

# ---- 唯一真相：临时 Web server 读同一数据目录（S5 期望③）----
echo "===== Web server 同目录读取 =====" >> "$PANE_LOG"
if [ ! -f "$ROOT/apps/web/dist-server/index.js" ]; then
  (cd "$ROOT/apps/web" && npm run build:server && npm run build:web) || { echo "build 失败"; exit 1; }
fi
fuser -k "$WEB_PORT/tcp" 2>/dev/null || true
# 防御性清残留锁（上次异常退出可能残留；T1-13 教训：kill 复合命令的 $! 只杀子 shell，
# node 变孤儿不释放锁——exec 让 $! 直接是 node 进程）
rm -f "$WORK/nextstep/web-panel.lock" 2>/dev/null || true
sleep 0.5
(cd "$ROOT/apps/web" && HOME="$WORK" PORT="$WEB_PORT" exec node dist-server/index.js) > "$WORK/web-server.log" 2>&1 &
WEB_PID=$!
trap 'kill "$WEB_PID" 2>/dev/null || true; fuser -k "$WEB_PORT/tcp" 2>/dev/null || true; tmux kill-session -t "$SESS" 2>/dev/null || true' EXIT
for i in $(seq 1 30); do
  curl -sf "http://localhost:$WEB_PORT/api/artifacts" >/dev/null 2>&1 && break
  sleep 0.5
done
# S5 期望③断言：Web API 读到与 CLI 冒烟同一份数据（同一 registry + 同一领域存储）。
# 无 projectId 时 /api/artifacts 只返回 projects（artifacts 恒空）→ 三段链路：
# projects → ?projectId= → 文档 detail
curl -sf "http://localhost:$WEB_PORT/api/artifacts" > "$WORK/web-read.log" 2>/dev/null
if grep -q '"name":"smoke"' "$WORK/web-read.log"; then
  echo "--- Web API 读到 smoke 项目（= CLI 冒烟数据目录） ---" >> "$PANE_LOG"
else
  echo "!!! Web API 未读到 smoke 项目（数据目录不一致） ---" >> "$PANE_LOG"
  cat "$WORK/web-read.log" >> "$PANE_LOG"
  exit 1
fi
PID=$(grep -o '"id":"[^"]*"' "$WORK/web-read.log" | head -1 | cut -d'"' -f4)
curl -sf "http://localhost:$WEB_PORT/api/artifacts?projectId=$PID" > "$WORK/web-read.log.2" 2>/dev/null
if grep -q "冒烟文档" "$WORK/web-read.log.2"; then
  echo "--- Web API 读到冒烟文档（CLI 创建的受管文档） ---" >> "$PANE_LOG"
else
  echo "!!! Web API 未读到冒烟文档 ---" >> "$PANE_LOG"
  cat "$WORK/web-read.log.2" >> "$PANE_LOG"
  exit 1
fi
# artifacts 数组取 id（projects 对象 id 在前，grep 首个 id 会误取项目 id → 404）
ART_ID=$(node -e "const j=JSON.parse(require('fs').readFileSync('$WORK/web-read.log.2','utf8'));process.stdout.write(j.artifacts[0].id)")
curl -sf "http://localhost:$WEB_PORT/api/artifacts/$ART_ID" >> "$WORK/web-read.log" 2>/dev/null
if grep -q '"currentVersion":2' "$WORK/web-read.log"; then
  echo "--- Web API 当前版本 v2（= CLI 冒烟物化版本） ---" >> "$PANE_LOG"
else
  echo "!!! Web API 当前版本 ≠ 2（冒烟物化 v2 未被读到） ---" >> "$PANE_LOG"
  cat "$WORK/web-read.log" >> "$PANE_LOG"
  exit 1
fi
echo "--- Web API 返回（冒烟文档版本链） ---" >> "$PANE_LOG"
cat "$WORK/web-read.log" >> "$PANE_LOG"
kill "$WEB_PID" 2>/dev/null
trap - EXIT

echo "=== S5 冒烟完成，证据：$PANE_LOG + $WORK/probe.log + $WORK/web-read.log + 领域目录 ==="
