// PM2 process definition for a second, isolated Hermes instance meant to be
// tunneled publicly (e.g. via ngrok) without touching the production `hermes`
// app defined in ecosystem.config.js.
//
// Run from the repo root:
//   pm2 start services/hermes/deploy/pm2/ecosystem.demo.config.js
//
// Config (port, strict auth, API key, rate limits) comes entirely from
// deploy/pm2/.env.demo via HERMES_ENV_FILE — the shared repo-root .env used
// by prod is never read by this process. See config.py's _ENV_FILE handling.

const REPO_DIR = process.env.REPO_DIR || "/opt/dosewise";

module.exports = {
  apps: [
    {
      name: "hermes-demo",
      cwd: `${REPO_DIR}/services/hermes`,
      script: "uv",
      args: "run hermes-serve",
      interpreter: "none",
      autorestart: true,
      restart_delay: 3000,
      max_restarts: 20,
      env: {
        REPO_DIR,
        HERMES_ENV_FILE: `${REPO_DIR}/services/hermes/deploy/pm2/.env.demo`,
        HERMES_RELOAD: "0",
        // Rate limits: process env overrides the .env.demo file (pydantic-settings
        // precedence), raising the demo caps to fit a real propose→confirm +
        // scan + suggest rhythm. The old .env.demo values (3/min, 20/hour) tripped
        // the "sending too fast" 429 within minutes of demoing. See MEMORY.md.
        RATE_LIMIT_TURNS_PER_MINUTE: "20",
        RATE_LIMIT_TURNS_PER_HOUR: "240",
        RATE_LIMIT_HTTP_PER_MINUTE: "80",
      },
    },
  ],
};
