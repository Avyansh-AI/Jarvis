#!/usr/bin/env bash
# Jarvis restore — put a backup tarball back. STOP THE HUB FIRST.
# Usage: bash scripts/restore.sh backups/max-backup-YYYYMMDD-HHMMSS.tar.gz
set -euo pipefail
cd "$(dirname "$0")/.."
FILE="${1:?need a backup tarball path}"
[ -f "$FILE" ] || { echo "no such file: $FILE"; exit 1; }
tar -tzf "$FILE" | grep -q '^data/' || { echo "that tarball doesn't look like a Jarvis backup (no data/)"; exit 1; }
if [ -d data ]; then
  SAFE="data/.pre-restore-$(date +%Y%m%d-%H%M%S).tgz"
  tar -czf "$SAFE" data
  echo "current data/ parked at $SAFE"
  # move encrypted stores aside so restore is clean but nothing is lost
  mkdir -p "/tmp/max-restore-old-$$" && mv data/* /tmp/max-restore-old-$$/ 2>/dev/null || true
fi
tar -xzf "$FILE"
echo "restored from $FILE — restart the hub."
