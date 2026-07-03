#!/usr/bin/env bash
# LAPTOP-side watcher: when the local .env changes, push it to the VPS.
#
# This is the secrets analogue of the VPS `watch-and-pull.sh` (which syncs code).
# Run it under PM2 *on your laptop* (see ecosystem.laptop.config.js) so editing
# .env auto-syncs to the VPS, mirroring the git flow for code. Change detection
# uses a checksum, so the file body is never printed.
#
# Env:
#   VPS_SSH        ssh target, user@host      (required)
#   VPS_REPO_DIR   repo path on the VPS       (default: /opt/dosewise)
#   POLL_SECONDS   seconds between checks      (default: 10)
#   ENV_FILE       local env file to watch     (default: <repo-root>/.env)

set -euo pipefail

: "${VPS_SSH:?set VPS_SSH=user@host (your VPS ssh target)}"
POLL_SECONDS="${POLL_SECONDS:-10}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd)"
ENV_FILE="${ENV_FILE:-$REPO_ROOT/.env}"

hash_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

last=""
echo "[env-push] watching $ENV_FILE -> $VPS_SSH every ${POLL_SECONDS}s"
while true; do
  if [ -f "$ENV_FILE" ]; then
    sig="$(hash_file "$ENV_FILE")"
    if [ "$sig" != "$last" ]; then
      echo "[env-push] .env changed; syncing"
      if VPS_SSH="$VPS_SSH" VPS_REPO_DIR="${VPS_REPO_DIR:-/opt/dosewise}" \
         ENV_FILE="$ENV_FILE" "$HERE/sync-env.sh"; then
        last="$sig"
      else
        echo "[env-push] sync failed; will retry"
      fi
    fi
  fi
  sleep "$POLL_SECONDS"
done
