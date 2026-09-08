#!/usr/bin/env bash
# Jarvis self-update — versioned, rollback-capable.
# Triggered by POST /api/system/update when ALLOW_SELF_UPDATE=1.
#
# Safety model:
#   - never update a dirty working tree
#   - current commit is tagged as max-rollback-<ts> before pulling
#   - after update, `node tools/check.js` must pass or we roll back
#   - data/ (encrypted stores, logs) is never touched
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d .git ]; then
  echo "not a git checkout — export a tarball or clone to enable updates"; exit 1
fi
if [ -n "$(git status --porcelain -- . ':!data')" ]; then
  echo "working tree dirty — refusing to update"; exit 1
fi

TS=$(date +%Y%m%d-%H%M%S)
git tag -f "max-rollback-$TS" HEAD >/dev/null 2>&1 || true
echo "rollback point: max-rollback-$TS"

git fetch --tags origin
CHANNEL="${MAX_UPDATE_CHANNEL:-main}"

# optional integrity gate: require the update commit to be GPG-signed
if [ "${MAX_REQUIRE_SIGNED:-0}" = "1" ]; then
  if ! git verify-commit "origin/$CHANNEL" 2>/dev/null; then
    echo "origin/$CHANNEL has no valid GPG signature — refusing to update (unset MAX_REQUIRE_SIGNED to bypass at your own risk)"; exit 1
  fi
  echo "signature verified on origin/$CHANNEL"
fi

git pull --ff-only origin "$CHANNEL"
# never fast-forward into a rewritten tree: confirm we only moved forward
if [ "$(git rev-list --count HEAD ^"max-rollback-$TS" 2>/dev/null || echo 0)" = "0" ] && [ "$(git rev-parse HEAD)" != "$(git rev-parse "max-rollback-$TS")" ]; then
  echo "history did not move forward — refusing"; git reset --hard "max-rollback-$TS"; exit 1
fi

if node tools/check.js; then
  echo "update ok — restart the hub: sudo systemctl restart maxai"
else
  echo "post-update check FAILED — rolling back"
  git reset --hard "max-rollback-$TS"
  exit 1
fi
