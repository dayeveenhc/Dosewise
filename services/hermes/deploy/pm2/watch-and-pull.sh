#!/usr/bin/env bash
# Polls the git remote for new commits on the VPS. If HEAD moved, pulls and
# restarts the `hermes` PM2 process. Run this itself under PM2 (see
# ecosystem.config.js) so it survives reboots/crashes just like hermes does.
#
# Env overrides:
#   REPO_DIR       path to the repo on the VPS      (default: /opt/dosewise)
#   GIT_BRANCH     branch to track                  (default: main)
#   POLL_SECONDS   seconds between checks            (default: 15)
#   PM2_APP_NAME   pm2 process name to restart       (default: hermes)

set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/dosewise}"
GIT_BRANCH="${GIT_BRANCH:-main}"
POLL_SECONDS="${POLL_SECONDS:-15}"
PM2_APP_NAME="${PM2_APP_NAME:-hermes}"

cd "$REPO_DIR"
echo "[watch-and-pull] watching $REPO_DIR ($GIT_BRANCH) every ${POLL_SECONDS}s"

while true; do
  git fetch --quiet origin "$GIT_BRANCH" || {
    echo "[watch-and-pull] git fetch failed, retrying in ${POLL_SECONDS}s"
    sleep "$POLL_SECONDS"
    continue
  }

  local_rev=$(git rev-parse HEAD)
  remote_rev=$(git rev-parse "origin/$GIT_BRANCH")

  if [ "$local_rev" != "$remote_rev" ]; then
    echo "[watch-and-pull] new commit detected: $local_rev -> $remote_rev"

    before_pyproject=$(git rev-parse HEAD:services/hermes/pyproject.toml 2>/dev/null || echo "")
    git pull --ff-only origin "$GIT_BRANCH"
    after_pyproject=$(git rev-parse HEAD:services/hermes/pyproject.toml 2>/dev/null || echo "")

    if [ "$before_pyproject" != "$after_pyproject" ]; then
      echo "[watch-and-pull] pyproject.toml changed, running uv sync"
      (cd services/hermes && uv sync)
    fi

    echo "[watch-and-pull] restarting pm2 process: $PM2_APP_NAME"
    pm2 restart "$PM2_APP_NAME"
  fi

  sleep "$POLL_SECONDS"
done
