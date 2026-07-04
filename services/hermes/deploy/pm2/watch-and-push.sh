#!/usr/bin/env bash
# Watches the local working tree on the VPS for file changes — from tmux +
# Claude Code editing, or anything else touching disk — and commits + pushes
# to the git remote so laptop-side `git pull` picks it up. Mirror of
# watch-and-pull.sh, but in the opposite direction.
#
# Uses inotifywait for near-instant reaction when available, falling back to
# polling every POLL_SECONDS if inotify-tools isn't installed.
#
# Run this itself under PM2 (see ecosystem.config.js) so it survives
# reboots/crashes just like hermes does.
#
# NOTE: mutually exclusive with hermes-git-sync (watch-and-pull.sh) — do not
# run both at once. If the VPS is the source of truth (tmux + Claude Code
# editing directly), stop hermes-git-sync (`pm2 stop hermes-git-sync`) before
# starting this, otherwise the pull loop's `git pull --ff-only` will fail
# whenever this script leaves the tree mid-commit, or a laptop push races a
# VPS commit and neither side can fast-forward.
#
# Env overrides:
#   REPO_DIR       path to the repo on the VPS      (default: /opt/dosewise)
#   GIT_BRANCH     branch to track                  (default: main)
#   POLL_SECONDS   fallback poll interval / debounce (default: 15 / 2)
#   COMMIT_PREFIX  prefix for auto-generated commits (default: "vps-edit:")

set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/dosewise}"
GIT_BRANCH="${GIT_BRANCH:-main}"
POLL_SECONDS="${POLL_SECONDS:-15}"
DEBOUNCE_SECONDS="${DEBOUNCE_SECONDS:-2}"
COMMIT_PREFIX="${COMMIT_PREFIX:-vps-edit:}"

cd "$REPO_DIR"

commit_and_push() {
  if [ -n "$(git status --porcelain)" ]; then
    git add -A
    git commit -m "$COMMIT_PREFIX $(date -u +%Y-%m-%dT%H:%M:%SZ)" --quiet

    if git push origin "$GIT_BRANCH" --quiet; then
      echo "[watch-and-push] pushed $(git rev-parse --short HEAD)"
    else
      echo "[watch-and-push] push failed (remote moved?) — pulling and retrying"
      git pull --rebase origin "$GIT_BRANCH" --quiet || {
        echo "[watch-and-push] rebase failed, needs manual resolution"
      }
      git push origin "$GIT_BRANCH" --quiet || echo "[watch-and-push] push still failing, will retry next cycle"
    fi
  fi
}

if command -v inotifywait >/dev/null 2>&1; then
  echo "[watch-and-push] watching $REPO_DIR ($GIT_BRANCH) via inotify, debounce ${DEBOUNCE_SECONDS}s"
  while true; do
    # Block until something changes, ignoring .git internals to avoid
    # reacting to our own commit/push writes.
    inotifywait -r -e modify,create,delete,move \
      --exclude '(^|/)\.git($|/)' \
      -q "$REPO_DIR" >/dev/null 2>&1 || true

    # Debounce: wait briefly for a burst of saves (e.g. an editor writing
    # several files) to settle before committing.
    sleep "$DEBOUNCE_SECONDS"
    commit_and_push
  done
else
  echo "[watch-and-push] inotifywait not found, falling back to polling every ${POLL_SECONDS}s"
  echo "[watch-and-push] install for instant sync: apt-get install -y inotify-tools"
  while true; do
    commit_and_push
    sleep "$POLL_SECONDS"
  done
fi
