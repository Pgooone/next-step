#!/usr/bin/env bash
# T1-13 E2E 一键编排（可重复执行）：build → 起薄 server（独立 HOME 数据目录，
# 不碰用户 ~/nextstep）→ 共享 fixture 种子 → 真浏览器驱动（S1–S4 + 冲突闭环
# + 通道①一致性 + 审计断言 + 截图）→ 收尾杀 server。
#
# 用法：npm run e2e（apps/web），或 bash e2e/run-e2e.sh
# 环境覆盖：PORT（默认 8790）；PW_EXECUTABLE（浏览器路径，缺省探测）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$ROOT/../.." && pwd)"
PORT="${PORT:-8790}"
RUN_DIR="$(mktemp -d /tmp/ns-e2e-run-XXXXXX)"
DATA="$RUN_DIR/nextstep"
SHOTS="$REPO/docs/rounds/round-1/qa/T1-13-shots"
LOG="$RUN_DIR/server.log"

export NS_E2E_DATA="$DATA"
export PORT="$PORT"
export SHOTS_DIR="$SHOTS"
# 浏览器环境（browser-e2e skill：缓存 chromium / 系统 Chrome；无则默认系统 Chrome）
if [ -f "$HOME/.local/bin/ns-browser-env.sh" ]; then
  # shellcheck disable=SC1090
  source "$HOME/.local/bin/ns-browser-env.sh"
fi
export PW_EXECUTABLE="${PW_EXECUTABLE:-/usr/bin/google-chrome}"

echo "[e2e] 数据目录=$DATA 截图=$SHOTS 浏览器=$PW_EXECUTABLE"
mkdir -p "$SHOTS"

echo "[e2e] build（server + web）..."
(cd "$ROOT" && npm run build:server && npm run build:web)

echo "[e2e] 起 server（PORT=$PORT，HOME=$RUN_DIR 隔离数据）..."
# 先清残留：上轮异常退出可能留 server/锁文件（端口占用会让 curl 探测误连旧实例）
fuser -k "$PORT/tcp" 2>/dev/null || true
sleep 0.5
cd "$ROOT" && HOME="$RUN_DIR" PORT="$PORT" node dist-server/index.js >"$LOG" 2>&1 &
SERVER_PID=$!
cd "$ROOT" # 恢复 cwd（后续 node 调用用绝对路径，不受影响）
trap 'kill "$SERVER_PID" 2>/dev/null || true; fuser -k "$PORT/tcp" 2>/dev/null || true' EXIT
READY=0
for _ in $(seq 1 60); do
  if curl -sf "http://localhost:$PORT/api/artifacts" >/dev/null 2>&1; then READY=1; break; fi
  sleep 0.5
done
if [ "$READY" != 1 ]; then
  echo "[e2e] server 未就绪，日志："
  cat "$LOG"
  exit 1
fi

echo "[e2e] seed 共享 fixture..."
node "$ROOT/e2e/fixture-seed.mjs"

echo "[e2e] 跑真浏览器驱动..."
node "$ROOT/e2e/drive-e2e.mjs"
STATUS=$?

echo "[e2e] 完成：status=$STATUS；server 日志=$LOG；数据目录=$RUN_DIR（可复用复跑）"
exit "$STATUS"
