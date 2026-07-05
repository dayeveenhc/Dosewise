#!/usr/bin/env bash
# Push the local (laptop) .env to the VPS over SSH — OUT OF BAND from git.
#
# Why this exists: `.env` is git-ignored, so `hermes-git-sync` (which pulls code)
# never carries your secrets. This streams the file laptop -> VPS directly via
# rsync/ssh; the contents never enter the repo, GitHub, or any AI chat, and rsync
# prints only the filename, never the file body.
#
# Run this on your LAPTOP, from the repo root:
#   VPS_SSH=you@your-vps ./services/hermes/deploy/pm2/sync-env.sh
#
# Env:
#   VPS_SSH        ssh target, user@host           (required)
#   VPS_REPO_DIR   repo path on the VPS            (default: /opt/dosewise)
#   ENV_FILE       local env file to push          (default: <repo-root>/.env)
#   RESTART        pm2 restart hermes after sync    (default: 1)

set -euo pipefail

: "${VPS_SSH:?set VPS_SSH=user@host (your VPS ssh target)}"
VPS_REPO_DIR="${VPS_REPO_DIR:-/opt/dosewise}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
ENV_FILE="${ENV_FILE:-$REPO_ROOT/.env}"
RESTART="${RESTART:-1}"

if [ ! -f "$ENV_FILE" ]; then
  echo "[sync-env] no env file at $ENV_FILE" >&2
  exit 1
fi

echo "[sync-env] pushing $(basename "$ENV_FILE") -> $VPS_SSH:$VPS_REPO_DIR/.env"
# -v lists the filename only, never the file body. Permissions are locked to
# owner-only via a follow-up `ssh chmod` (below) rather than rsync's --chmod flag,
# since macOS ships a stock rsync (2.6.9) too old to support --chmod (added in 3.1).
rsync -e ssh -v "$ENV_FILE" "$VPS_SSH:$VPS_REPO_DIR/.env"
ssh "$VPS_SSH" "chmod 600 '$VPS_REPO_DIR/.env'"

if [ "$RESTART" = "1" ]; then
  echo "[sync-env] restarting hermes so it re-reads .env"
  # hermes reads repo-root .env at process start (pydantic-settings), so a plain
  # restart picks up the new values.
  ssh "$VPS_SSH" "pm2 restart hermes"
fi

echo "[sync-env] done"
