// PM2 process for your LAPTOP (NOT the VPS).
//
// Auto-pushes your local .env to the VPS whenever it changes, so the VPS gets
// secrets (e.g. MONGODB_URI) that git-sync can't carry — .env is git-ignored on
// purpose. Secrets travel laptop -> VPS over SSH only: never through git, GitHub,
// or an AI chat.
//
// Run from the repo root on your laptop:
//   VPS_SSH=you@your-vps pm2 start services/hermes/deploy/pm2/ecosystem.laptop.config.js
//   pm2 save
//
// One-off push without the watcher:
//   VPS_SSH=you@your-vps ./services/hermes/deploy/pm2/sync-env.sh

const REPO_DIR = process.env.REPO_DIR || process.cwd();

module.exports = {
  apps: [
    {
      name: "hermes-env-push",
      cwd: REPO_DIR,
      script: `${REPO_DIR}/services/hermes/deploy/pm2/watch-and-push-env.sh`,
      interpreter: "bash",
      autorestart: true,
      env: {
        // Required — set it on the pm2 start command line (above) or here.
        VPS_SSH: process.env.VPS_SSH || "",
        VPS_REPO_DIR: process.env.VPS_REPO_DIR || "/opt/dosewise",
        POLL_SECONDS: process.env.POLL_SECONDS || "10",
      },
    },
  ],
};
