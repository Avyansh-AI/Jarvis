#!/usr/bin/env bash
# Jarvis backup — snapshot the encrypted data/ dir (stores are encrypted, so the
# tarball is NOT plaintext; keep .env OUT of it on purpose).
# Usage: bash scripts/backup.sh [outdir]
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-backups}"
mkdir -p "$OUT"
TS=$(date +%Y%m%d-%H%M%S)
FILE="$OUT/max-backup-$TS.tar.gz"
tar --exclude='data/*.tmp' -czf "$FILE" data
chown "$(id -u):$(id -g)" "$FILE" 2>/dev/null || true
chmod 600 "$FILE"
echo "backup written: $FILE ($(du -h "$FILE" | cut -f1))"
echo "NOTE: without data/.master.key (or MAX_SECRET) the stores can't be decrypted — back up .master.key separately in a safe place."
