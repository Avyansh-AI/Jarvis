#!/usr/bin/env bash
# Jarvis — secure disposal (Round 6). Destroys ALL hub-side secrets and data:
#   data/ (encrypted stores, .master.key, event log, fingerprints), backups/.
# Usage: scripts/decommission.sh --yes     (without --yes it prints the plan)
set -u
cd "$(dirname "$0")/.."
DATA="${MAX_DATA_DIR:-data}"

echo "Jarvis decommission — this will permanently destroy:"
echo "  - $DATA/ (memory, voiceprints, settings + all API keys, .master.key, event log)"
echo "  - backups/ (any local backup tarballs)"
echo "  - $DATA/integrity.sha256 manifest"
echo "It will NOT uninstall the code — after wiping you can safely delete or reflash."

if [ "${1:-}" != "--yes" ]; then
  echo "Re-run with --yes to proceed. Satellites: reflash with stock firmware (esptool.py erase_flash) to clear Wi-Fi creds + SAT_TOKEN."
  exit 0
fi

shred_dir() {  # overwrite-then-delete where shred exists; rm fallback elsewhere (flash: noting caveat)
  local dir="$1"
  if command -v shred >/dev/null 2>&1; then
    find "$dir" -type f -exec shred -u -n 1 -z {} \; 2>/dev/null
  fi
  rm -rf "$dir"
}

shred_dir "$DATA"
[ -d backups ] && shred_dir backups
echo "[decommission] hub data destroyed. NOTE: on SD/eMMC flash, overwrite tools are advisory —"
echo "  for true certitude, physically destroy or full-disk-erase the storage medium."
echo "[decommission] satellites: esptool.py erase_flash (clears Wi-Fi credentials + SAT_TOKEN)."
echo "Done. Jarvis is decommissioned."
