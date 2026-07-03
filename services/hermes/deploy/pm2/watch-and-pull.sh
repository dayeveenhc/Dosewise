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

    git pull --ff-only origin "$GIT_BRANCH"

    # Sync deps (incl. dev, so the test gate can run) and gate the restart on a
    # green offline test suite — a bad commit is pulled to disk but NOT activated
    # (the running process keeps serving the previous code until tests pass).
    echo "[watch-and-pull] syncing deps"
    (cd services/hermes && uv sync --extra dev)

    if [ "${RUN_TESTS:-1}" = "1" ]; then
      echo "[watch-and-pull] running test gate before restart"
      if (cd services/hermes && uv run pytest -q -m "not integration"); then
        echo "[watch-and-pull] tests passed; restarting pm2 process: $PM2_APP_NAME"
        pm2 restart "$PM2_APP_NAME"
      else
        echo "[watch-and-pull] TESTS FAILED for $remote_rev — NOT restarting; still serving previous code"
      fi
    else
      echo "[watch-and-pull] RUN_TESTS=0; restarting pm2 process: $PM2_APP_NAME"
      pm2 restart "$PM2_APP_NAME"
    fi
  fi

  sleep "$POLL_SECONDS"
done
