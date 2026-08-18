#!/usr/bin/env bash
# 发行轨 A 真模型端到端冒烟：`pi --extension src/extension-entry.ts`（扩展入口本身，
# jiti 直跑 TS）→ 六工具注册 → create_artifact → propose_edit → 汇总卡逐键确认 →
# 物化 v2 → 领域目录 + 审计条目断言。T1-10 冒烟范式的扩展入口版。
# 留证：/tmp/rel-a-smoke/smoke.pane（tmux 逐帧）+ 领域目录 + 会话 JSONL 审计条目。
# 隔离：HOME=/tmp/rel-a-smoke-home（~/.nextstep 注册表与 ~/.pi 会话全隔离，不污染用户环境）。
set -u
WORK=/tmp/rel-a-smoke
FAKE_HOME=/tmp/rel-a-smoke-home
ROOT=/home/pgoone/GitHubproject/nextstep重构
PI_CLI="$ROOT/node_modules/.bin/pi"
ENTRY="$ROOT/packages/next-step-pi/src/extension-entry.ts"
SESS="rel-a-smoke"
PANE_LOG="$WORK/smoke.pane"
TOOLS="create_artifact,propose_edit,list_artifacts,get_artifact_diff,list_my_artifacts,get_artifact_history,read,grep,glob,list"

rm -rf "$WORK" "$FAKE_HOME"
mkdir -p "$WORK/.pi" "$FAKE_HOME"
: > "$PANE_LOG"

set -a
# shellcheck disable=SC1090
source <(grep -E '^DEEPSEEK_' "$ROOT/.env.pi-test")
set +a

# 临时 models.json（项目级 .pi/，不进仓库）：DeepSeek provider，
# apiKey 用 $DEEPSEEK_API_KEY 环境插值（key 永不落盘）
cat > "$WORK/.pi/models.json" <<EOF
{
  "providers": {
    "deepseek": {
      "baseUrl": "$DEEPSEEK_BASE_URL",
      "api": "openai-completions",
      "apiKey": "\$DEEPSEEK_API_KEY",
      "authHeader": true,
      "models": [
        {
          "id": "$DEEPSEEK_MODEL",
          "name": "DeepSeek (rel-a-smoke)",
          "reasoning": false,
          "input": ["text"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 128000,
          "maxTokens": 8192
        }
      ]
    }
  }
}
EOF

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
  "export HOME='$FAKE_HOME' DEEPSEEK_API_KEY='$DEEPSEEK_API_KEY' DEEPSEEK_BASE_URL='$DEEPSEEK_BASE_URL' DEEPSEEK_MODEL='$DEEPSEEK_MODEL'; cd $WORK && $PI_CLI --extension $ENTRY --model deepseek/$DEEPSEEK_MODEL --no-session --no-context-files --no-skills --approve --tools $TOOLS 2>&1"
sleep 4
shot "pi 启动 4s（扩展入口加载帧）"
wait_for '>|❯|┃' 30 || shot "启动超时"
sleep 2
shot "启动完成（入口装配：六工具注册 + 守卫 + 审计适配）"

# ---- 场景：建文档 → 提案 → 汇总卡确认 → 物化（T1-10 同款五步）
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

# ---- 领域目录断言（物化 + 版本链）+ 审计条目断言
echo "===== 领域目录证据 =====" >> "$PANE_LOG"
find "$WORK/nextstep/artifacts/managed" -type f 2>/dev/null | sort >> "$PANE_LOG"
echo "--- 物化文件内容（应含修改后的需求段落） ---" >> "$PANE_LOG"
cat "$WORK/冒烟文档.md" 2>/dev/null >> "$PANE_LOG"
echo "--- versions 快照 ---" >> "$PANE_LOG"
for f in "$WORK"/nextstep/artifacts/managed/*/versions/*.json; do
  [ -f "$f" ] && cat "$f" >> "$PANE_LOG"
done
echo "--- 隔离 HOME 注册表（应含 rel-a-smoke 项目） ---" >> "$PANE_LOG"
cat "$FAKE_HOME/nextstep/projects.json" 2>/dev/null >> "$PANE_LOG"
echo "--- 会话 JSONL 审计条目（customType=next-step，含 materialize/approval_response） ---" >> "$PANE_LOG"
grep -h '"customType":"next-step"' "$FAKE_HOME"/.pi/agent/sessions/*.jsonl 2>/dev/null | head -5 >> "$PANE_LOG"

echo "=== 冒烟完成，证据：$PANE_LOG + 领域目录 + 会话审计 ==="
