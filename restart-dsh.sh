#!/bin/bash
# restart-dsh.sh — restart the dsh web server (loads the RTK-patched bash tool).
#
# Designed to run FULLY DETACHED (nohup, output redirected) because the dsh
# web server hosts the agent that launches this script: killing the old server
# also kills that agent's current turn, so this script must survive on its own.
#
# Sequence:
#   1. sleep DELAY seconds (let the launching agent turn finish)
#   2. kill the current `dsh web` process (SIGTERM, then SIGKILL after 30s)
#   3. start the new server (same command: dsh web --no-open), nohup + log
#   4. wait for HTTP 200 on 127.0.0.1:3080 (up to 60s)
#   5. write a verification report to the report path
#
# Usage: nohup bash restart-dsh.sh >/tmp/dsh-restart-run.log 2>&1 &

set -u

DSH_BIN="/Users/Robbin/.workbuddy/binaries/node/versions/22.22.2/bin/dsh"
PORT="3080"
DELAY="${DSH_RESTART_DELAY:-30}"
REPORT="/Users/Robbin/Documents/WorkSapce/DeepSeek/DSH 插件/rtk-token-keeper/restart-report.txt"
SERVER_LOG="/tmp/dsh-web.log"

echo "[restart] start $(date '+%Y-%m-%d %H:%M:%S') delay=${DELAY}s"

# 1. Let the launching agent turn finish before we kill its host process.
sleep "$DELAY"

# 2. Find and stop the current server.
# Use lsof by port (not pgrep): under the dsh bash sandbox, pgrep cannot see
# the server's command line, but the port listener lookup always works.
OLD_PID="$(lsof -tiTCP:${PORT} -sTCP:LISTEN 2>/dev/null | head -1 || true)"
echo "[restart] old pid (listener on :${PORT}): ${OLD_PID:-none}"
if [ -n "${OLD_PID:-}" ]; then
  kill "$OLD_PID" 2>/dev/null || true
  for _ in $(seq 1 30); do
    if ! kill -0 "$OLD_PID" 2>/dev/null; then break; fi
    sleep 1
  done
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[restart] old server did not exit gracefully — SIGKILL"
    kill -9 "$OLD_PID" 2>/dev/null || true
    sleep 2
  fi
fi

# 3. Start the new server (detached, logged).
cd /Users/Robbin || true
NODE_BIN="/Users/Robbin/.workbuddy/binaries/node/versions/22.22.2/bin/node"
nohup "$NODE_BIN" "$DSH_BIN" web --no-open >>"$SERVER_LOG" 2>&1 &
NEW_PID=$!
echo "[restart] new pid: $NEW_PID"

# 4. Wait for readiness.
CODE=""
READY=0
for _ in $(seq 1 60); do
  CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/" 2>/dev/null || true)"
  if [ "$CODE" = "200" ]; then READY=1; break; fi
  sleep 1
done

# 5. Write the report.
{
  echo "=== dsh web restart report $(date '+%Y-%m-%d %H:%M:%S') ==="
  echo "http_ready=$READY (last code=${CODE:-none})"
  echo "new_pid=$NEW_PID alive=$(kill -0 "$NEW_PID" 2>/dev/null && echo yes || echo no)"
  echo "--- listener on :${PORT} ---"
  lsof -iTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null || echo "(none)"
  echo "--- server log tail ---"
  tail -n 20 "$SERVER_LOG" 2>/dev/null || echo "(no log)"
  echo "--- rtk patch check ---"
  "$NODE_BIN" "/Users/Robbin/Documents/WorkSapce/DeepSeek/DSH 插件/rtk-token-keeper/patch-rtk.mjs" check || true
} > "$REPORT" 2>&1

echo "[restart] done — report: $REPORT"
