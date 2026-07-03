// PM2 process definitions for the VPS.
//
// Run from the repo root:
//   pm2 start services/hermes/deploy/pm2/ecosystem.config.js
//   pm2 save            # persist this process list
//   pm2 startup         # generate the systemd hook so PM2 itself survives reboot
//
// DEFAULT SETUP (edit directly on the VPS, e.g. via SSH + tmux + Claude Code):
//   Only the `hermes` app runs. HERMES_RELOAD=1 makes uvicorn watch its own
//   source and restart itself the instant a file is saved on this disk — no
//   git push, no PM2 restart, no second process needed.
//
// ALTERNATIVE (you edit on your laptop instead, and push to git):
//   Uncomment the `hermes-git-sync` app below. It polls origin, git pulls, and
//   restarts `hermes` when a new commit lands. Requires `git push` per change.
//
// `cwd` paths are relative to the repo root — the machine's HOME is used as a
// stable execution base; on Linux VPS this file runs via `pm2 start <path>`
// from wherever you invoke it, but cwd below is always resolved from REPO_DIR.

const REPO_DIR = process.env.REPO_DIR || "/opt/dosewise";

module.exports = {
  apps: [
    {
      name: "hermes",
      cwd: `${REPO_DIR}/services/hermes`,
      script: "uv",
      args: "run hermes-serve",
      interpreter: "none",
      autorestart: true,
      restart_delay: 3000,
      max_restarts: 20,
      env: {
        REPO_DIR,
        // Self-restarts on any saved change under services/hermes/src — the
        // whole point of editing directly on the VPS. No PM2 restart needed.
        HERMES_RELOAD: "1",
      },
    },

    // Watches the git remote; pulls + restarts `hermes` when a new commit
    // lands. Enables "edit on laptop -> git push -> VPS auto-updates".
    {
      name: "hermes-git-sync",
      cwd: REPO_DIR,
      script: `${REPO_DIR}/services/hermes/deploy/pm2/watch-and-pull.sh`,
      interpreter: "bash",
      autorestart: true,
      env: {
        REPO_DIR,
        GIT_BRANCH: process.env.GIT_BRANCH || "main",
        POLL_SECONDS: process.env.POLL_SECONDS || "15",
        PM2_APP_NAME: "hermes",
      },
    },
  ],
};
