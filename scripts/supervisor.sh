#!/usr/bin/env bash
# Jarvis supervisor — keeps the hub alive with capped backoff.
# Usage: bash scripts/supervisor.sh   (or: MAX_WATCHDOG_EXIT=1 node hub/server.js under systemd)
cd "$(dirname "$0")/.."
export MAX_WATCHDOG_EXIT="${MAX_WATCHDOG_EXIT:-1}"   # a wedged loop exits → we restart it
SERVER_CMD="${MAX_SERVER_CMD:-node hub/server.js}"   # overridable for chaos tests
RESTARTS=0
WINDOW_START=$(date +%s)
BACKOFF=1
while true; do
  echo "[supervisor] starting hub ($(date +%T))…"
  $SERVER_CMD
  CODE=$?
  NOW=$(date +%s)
  if (( NOW - WINDOW_START > 60 )); then RESTARTS=0; WINDOW_START=$NOW; BACKOFF=1; fi
  RESTARTS=$((RESTARTS + 1))
  if (( RESTARTS > 5 )); then
    echo "[supervisor] 5 restarts inside a minute — backing off 60s (check logs)"
    sleep 60; RESTARTS=0; WINDOW_START=$(date +%s); BACKOFF=1
    continue
  fi
  echo "[supervisor] hub exited (code $CODE) — restarting in ${BACKOFF}s"
  sleep "$BACKOFF"
  BACKOFF=$(( BACKOFF < 30 ? BACKOFF * 2 : 30 ))
done
