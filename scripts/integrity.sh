#!/usr/bin/env bash
# Jarvis — boot integrity manifest (Round 6).
#   scripts/integrity.sh write   → record SHA-256 of every code file (hub/, web/, tools/, scripts/, satellite/)
#   scripts/integrity.sh verify  → compare the working tree against that manifest
# Best run at boot (supervisor/systemd) and after updates. The manifest lives
# OUTSIDE the code tree (data/integrity.sha256) with 0600 perms.
set -u
cd "$(dirname "$0")/.."
MANIFEST="${MAX_DATA_DIR:-data}/integrity.sha256"
FILES=$(find hub web tools scripts satellite docs -type f \( -name '*.js' -o -name '*.html' -o -name '*.css' -o -name '*.sh' -o -name '*.ino' -o -name '*.md' -o -name '*.json' \) 2>/dev/null | sort)

case "${1:-verify}" in
  write)
    mkdir -p "$(dirname "$MANIFEST")"
    # shellcheck disable=SC2086
    sha256sum $FILES > "$MANIFEST"
    chmod 600 "$MANIFEST"
    echo "[integrity] manifest written: $(wc -l < "$MANIFEST") files"
    ;;
  verify)
    if [ ! -f "$MANIFEST" ]; then
      echo "[integrity] no manifest — run: scripts/integrity.sh write  (skipping check)"
      exit 0
    fi
    if sha256sum -c "$MANIFEST" --quiet 2>/dev/null; then
      echo "[integrity] OK — $(wc -l < "$MANIFEST") files match"
      exit 0
    else
      echo "[integrity] FAIL — modified code files:" >&2
      sha256sum -c "$MANIFEST" --quiet 2>/dev/null | grep -v ': OK' >&2 || true
      exit 1
    fi
    ;;
esac
