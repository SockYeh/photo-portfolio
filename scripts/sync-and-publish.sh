#!/usr/bin/env bash
# Wrapper for the daily VSCO sync, invoked by deploy/vsco-sync.service.
#
# systemd does not load a login shell, so an nvm-installed `node` is invisible to
# it. This script sources nvm itself and fails loudly on missing dependencies
# rather than silently writing nothing.
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-/home/sockyeh/photo-portfolio}"
cd "$PROJECT_DIR"

if ! command -v node >/dev/null 2>&1; then
  for candidate in "$HOME/.nvm/nvm.sh" /usr/local/share/nvm/init-nvm.sh; do
    if [ -s "$candidate" ]; then
      # shellcheck disable=SC1090
      . "$candidate" >/dev/null 2>&1 || true
      break
    fi
  done
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node not found on PATH. Install Node 18+ or set PROJECT_DIR/PATH." >&2
  exit 127
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl not found. Install it with: sudo apt-get install -y curl" >&2
  exit 127
fi

echo "[sync] $(date -Is) starting VSCO sync"
node scripts/sync.mjs

# Announce new photos to subscribers. notify.mjs reads .env itself and exits
# cleanly when the newsletter is not yet configured, so no env gate is needed
# here — one would disagree with the script about what is actually set.
# A non-zero exit here is a genuine failure and does fail the unit.
node scripts/notify.mjs

# Optional: commit and push the refreshed photos.json so CI redeploys the site.
# Off by default — set PUBLISH=1 in the service's Environment= line to enable.
if [ "${PUBLISH:-0}" = "1" ]; then
  if git rev-parse --git-dir >/dev/null 2>&1; then
    git add src/data/photos.json
    if git diff --cached --quiet; then
      echo "[sync] photos.json unchanged"
    else
      git commit -m "chore: sync VSCO photos"
      git push
    fi
  else
    echo "[sync] PUBLISH=1 set but $PROJECT_DIR is not a git repo; skipping" >&2
  fi
fi

echo "[sync] $(date -Is) done"
