#!/usr/bin/env bash
# T1-10 真模型端到端冒烟：doc 会话六工具 → create_artifact → propose_edit →
# 汇总卡逐键确认 → 物化 v2 → 领域目录断言（F1 纯 CLI 端到端首次真实验证）
# 留证：/tmp/t1-10-smoke/smoke.pane（每步 capture-pane）+ probe.log + 领域目录快照
set -u
WORK=/tmp/t1-10-smoke
ROOT=/home/pgoone/GitHubproject/nextstep重构
PI_CLI="$ROOT/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
SESS="t1-10-smoke"
PANE_LOG="$WORK/smoke.pane"
TOOLS="create_artifact,propose_edit,list_artifacts,get_artifact_diff,list_my_artifacts,get_artifact_history"

rm -rf "$WORK"
mkdir -p "$WORK"
# 探针拷至 WORK 复跑（T1-09 同款：证据留在 /tmp，仓库保留源）
cp "$(dirname "$0")/probe.ts" "$WORK/probe.ts"
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
  "export DEEPSEEK_API_KEY='$DEEPSEEK_API_KEY' DEEPSEEK_BASE_URL='$DEEPSEEK_BASE_URL' DEEPSEEK_MODEL='$DEEPSEEK_MODEL'; cd $WORK && node $PI_CLI --extension $WORK/probe.ts --model deepseek/$DEEPSEEK_MODEL --no-session --no-context-files --no-skills --approve --tools $TOOLS 2>&1"
sleep 4
shot "pi 启动 4s"
wait_for '>|❯|┃' 30 || shot "启动超时"
sleep 2
shot "启动完成（能力层白名单 = --tools 六工具，物理无 write/edit/bash）"

# ---- 场景：创建文档 + 提议修改 + 汇总卡确认 → 物化
tmux send-keys -t "$SESS" \
  "请先调用 create_artifact 创建一份受管设计文档（kind=design，title=冒烟文档，content 为：## 需求\n原始需求段落。）；创建完成后，立即调用 propose_edit 对这份文档提议修改（把“原始需求段落。”改为“修改后的需求段落。”），参数 id 用上一步返回的 id。" Enter
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

# ---- 领域目录断言（物化 + 版本链 + pending 清理）
echo "===== 领域目录证据 =====" >> "$PANE_LOG"
find "$WORK/nextstep/artifacts/managed" -type f 2>/dev/null | sort >> "$PANE_LOG"
echo "--- 物化文件内容（应含修改后的需求段落） ---" >> "$PANE_LOG"
cat "$WORK/冒烟文档.md" 2>/dev/null >> "$PANE_LOG"
echo "--- versions 快照 ---" >> "$PANE_LOG"
for f in "$WORK"/nextstep/artifacts/managed/*/versions/*.json; do
  [ -f "$f" ] && cat "$f" >> "$PANE_LOG"
done

echo "=== 冒烟完成，证据：$PANE_LOG + $WORK/probe.log + 领域目录 ==="
