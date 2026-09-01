#!/bin/bash
# restart-dsh.sh — restart the dsh web server (loads the RTK-patched bash tool).
#
# Designed to run FULLY DETACHED (nohup, output redirected) because the dsh
# web server hosts the agent that launches this script: killing the old server
# also kills that agent's current turn, so this script must survive on its own.
#
# Two restart modes, auto-detected:
#   A) LaunchAgent (macOS): if the service DSH_LAUNCH_LABEL (default
#      ai.deepseek.harness) is loaded, restart it via launchctl kickstart -k.
#      Never kill/start the process by hand in this mode — with KeepAlive=true
#      launchd respawns it and fights a manually started copy over the port.
#   B) Manual: kill the :PORT listener (SIGTERM, SIGKILL after 30s), then start
#      a fresh server with nohup. The dsh CLI is discovered from DSH_BIN,
#      PATH, or the usual global npm roots (Homebrew / /usr/local).
#
# Sequence:
#   1. sleep DELAY seconds (let the launching agent turn finish)
#   2. restart (mode A or B as above)
#   3. wait for HTTP 200 on 127.0.0.1:PORT (up to 90s)
#   4. write a verification report (incl. rtk patch check) to the report path
#
# Usage: nohup bash restart-dsh.sh >/tmp/dsh-restart-run.log 2>&1 &

set -u

PORT="${DSH_PORT:-3080}"
DELAY="${DSH_RESTART_DELAY:-30}"
LABEL="${DSH_LAUNCH_LABEL:-ai.deepseek.harness}"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPORT="${DSH_RESTART_REPORT:-$HERE/restart-report.txt}"
SERVER_LOG="/tmp/dsh-web.log"
LAUNCH_ERR_LOG="$HOME/Library/Logs/deepseek-harness.err.log"

find_dsh_bin() {
  if [ -n "${DSH_BIN:-}" ] && [ -f "$DSH_BIN" ]; then echo "$DSH_BIN"; return 0; fi
  local from_path
  from_path="$(command -v dsh 2>/dev/null || true)"
  if [ -n "$from_path" ]; then echo "$from_path"; return 0; fi
  local candidate
  for candidate in \
    /opt/homebrew/bin/dsh \
    /usr/local/bin/dsh \
    "$HOME/.workbuddy/binaries/node/versions/22.22.2/bin/dsh"; do
    if [ -f "$candidate" ]; then echo "$candidate"; return 0; fi
  done
  return 1
}

find_node_bin() {
  if [ -n "${NODE_BIN:-}" ] && [ -x "$NODE_BIN" ]; then echo "$NODE_BIN"; return 0; fi
  local from_path
  from_path="$(command -v node 2>/dev/null || true)"
  if [ -n "$from_path" ]; then echo "$from_path"; return 0; fi
  local candidate
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$candidate" ]; then echo "$candidate"; return 0; fi
  done
  return 1
}

echo "[restart] start $(date '+%Y-%m-%d %H:%M:%S') delay=${DELAY}s"

# 1. Let the launching agent turn finish before we kill its host process.
sleep "$DELAY"

MODE="manual"
if [ "$(uname -s)" = "Darwin" ] && launchctl print "gui/$(id -u)/${LABEL}" >/dev/null 2>&1; then
  MODE="launchagent"
fi
echo "[restart] mode=$MODE"

if [ "$MODE" = "launchagent" ]; then
  # 2A. launchd stops the old process and starts a fresh one.
  launchctl kickstart -k "gui/$(id -u)/${LABEL}"
  echo "[restart] kickstart sent for ${LABEL}"
else
  # 2B. Find and stop the current server, then start a new one detached.
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
  DSH_BIN="$(find_dsh_bin || true)"
  NODE_BIN="$(find_node_bin || true)"
  if [ -z "${DSH_BIN:-}" ] || [ -z "${NODE_BIN:-}" ]; then
    echo "[restart] FATAL: dsh or node not found (set DSH_BIN / NODE_BIN)" >&2
    exit 1
  fi
  cd "$HOME" || true
  nohup "$NODE_BIN" "$DSH_BIN" web --no-open >>"$SERVER_LOG" 2>&1 &
  echo "[restart] new pid: $!"
fi

# 3. Wait for readiness.
CODE=""
READY=0
for _ in $(seq 1 90); do
  CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/" 2>/dev/null || true)"
  if [ "$CODE" = "200" ]; then READY=1; break; fi
  sleep 1
done

# 4. Write the report.
{
  echo "=== dsh web restart report $(date '+%Y-%m-%d %H:%M:%S') ==="
  echo "mode=$MODE http_ready=$READY (last code=${CODE:-none})"
  if [ "$MODE" = "launchagent" ]; then
    echo "--- service ---"
    launchctl print "gui/$(id -u)/${LABEL}" 2>/dev/null | grep -E 'state|pid|program' | head -5 || echo "(print failed)"
  fi
  echo "--- listener on :${PORT} ---"
  lsof -iTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null || echo "(none)"
  echo "--- server log tail ---"
  if [ "$MODE" = "launchagent" ] && [ -f "$LAUNCH_ERR_LOG" ]; then
    tail -n 20 "$LAUNCH_ERR_LOG" 2>/dev/null || echo "(no log)"
  else
    tail -n 20 "$SERVER_LOG" 2>/dev/null || echo "(no log)"
  fi
  echo "--- rtk patch check ---"
  NODE_FOR_CHECK="$(find_node_bin || true)"
  if [ -n "${NODE_FOR_CHECK:-}" ] && [ -f "$HERE/patch-rtk.mjs" ]; then
    "$NODE_FOR_CHECK" "$HERE/patch-rtk.mjs" check || true
  else
    echo "(skipped: node or patch-rtk.mjs not found)"
  fi
} > "$REPORT" 2>&1

echo "[restart] done — report: $REPORT"
