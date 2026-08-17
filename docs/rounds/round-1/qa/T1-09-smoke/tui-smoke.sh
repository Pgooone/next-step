#!/usr/bin/env bash
# T1-09 真 TUI 冒烟：汇总卡渲染 → 逐键翻转 → 提交 / Esc 取消
# 留证：/tmp/t1-09-smoke/smoke.pane（每步 capture-pane）+ probe.log（execute 事件）
set -u
WORK=/tmp/t1-09-smoke
ROOT=/home/pgoone/GitHubproject/nextstep重构
PI_CLI="$ROOT/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
SESS="t1-09-smoke"
PANE_LOG="$WORK/smoke.pane"
: > "$PANE_LOG"
: > "$WORK/probe.log"

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

tmux new-session -d -s "$SESS" -x 100 -y 32 \
  "export DEEPSEEK_API_KEY='$DEEPSEEK_API_KEY' DEEPSEEK_BASE_URL='$DEEPSEEK_BASE_URL' DEEPSEEK_MODEL='$DEEPSEEK_MODEL'; cd $WORK && node $PI_CLI --extension $WORK/probe.ts --model deepseek/$DEEPSEEK_MODEL --no-session --no-context-files --no-skills --approve --tools smoke_propose 2>&1"
sleep 4
shot "pi 启动 4s"
wait_for '>|❯|┃' 30 || shot "启动超时"
sleep 2
shot "启动完成"

# ---- 场景 1：y1 → a 全收 → n2 打回 → Enter 提交（resolved 4? 不，3 块：y1 后 a 全收再 n2 → 2 收 1 拒）
tmux send-keys -t "$SESS" "调用 smoke_propose 工具，走一遍确认流程。" Enter
sleep 2
wait_for '已决 0/' 90 || shot "卡片未出现"
shot "汇总卡初始帧"
tmux send-keys -t "$SESS" y 1
sleep 1
shot "按 y1（块1 接受）"
tmux send-keys -t "$SESS" a
sleep 1
shot "按 a（全收）"
tmux send-keys -t "$SESS" n 2
sleep 1
shot "按 n2（打回块2 拒绝，混合档）"
tmux send-keys -t "$SESS" Enter
sleep 2
shot "Enter 提交"
wait_for 'smoke result: resolved' 60 || shot "未等到 resolved"
shot "场景1 结果帧"

# ---- 场景 2：pending 提交被拒提示 → q 取消
tmux send-keys -t "$SESS" "再调用一次 smoke_propose 工具。" Enter
sleep 2
wait_for '已决 0/' 90 || shot "卡片未出现(2)"
shot "场景2 卡片初始帧"
tmux send-keys -t "$SESS" Enter
sleep 1
shot "Enter（全 pending，应提示拒绝提交）"
tmux send-keys -t "$SESS" q
sleep 2
shot "按 q 取消"
wait_for 'smoke result: cancelled' 60 || shot "未等到 cancelled"
shot "场景2 结果帧"

# ---- 场景 3：Esc（\x1b）取消
tmux send-keys -t "$SESS" "再调用一次 smoke_propose 工具。" Enter
sleep 2
wait_for '已决 0/' 90 || shot "卡片未出现(3)"
shot "场景3 卡片初始帧"
tmux send-keys -t "$SESS" Escape
sleep 2
shot "按 Esc 取消"
wait_for 'smoke result: cancelled' 60 || shot "未等到 cancelled(3)"
shot "场景3 结果帧"

echo "=== 冒烟完成，证据：$PANE_LOG + $WORK/probe.log ==="
