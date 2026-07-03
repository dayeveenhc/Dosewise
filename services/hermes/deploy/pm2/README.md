# PM2 deployment (no Mutagen, no Docker)

> **This is the canonical runtime for the Telegram demo.** Run `hermes` under PM2
> in **polling** mode (`HERMES_CHANNEL_MODE=polling`) — no TLS, public URL, or
> webhook needed. The systemd + Caddy path in `../README.md` is the alternative
> for **webhook** mode; Docker Compose is a third option. Pick one — don't run two
> process managers against port 8000 at once.

**Default setup: edit directly on the VPS.** SSH in, run `tmux`, run `claude`
(Claude Code) inside it, and edit `/opt/dosewise` in place — same filesystem
Hermes reads from. `hermes-serve` self-restarts on save (`HERMES_RELOAD=1`, set
in `ecosystem.config.js`), so there's nothing to sync and no git push required
for the dev loop. tmux just lets you detach/reattach that SSH session; PM2 keeps
`hermes` itself running independent of tmux, git, and reboots.

Still `git push` to GitHub for backup/version history — just not on every
change, and not as a trigger for anything.

**Alternative: edit on your laptop instead.** Then something has to get your
changes onto the VPS. Two options, both push-triggered (git commit required):
Mutagen (file sync on save) or the `hermes-git-sync` PM2 app below (git-poll on
push). See the commented-out block in `ecosystem.config.js` to enable it.

## 1. Install Node.js + PM2 on the VPS (one time)

```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo bash -   # Debian/Ubuntu
sudo apt-get install -y nodejs
sudo npm install -g pm2
```

## 2. Get the repo + `.env` on the VPS (one time)

```bash
sudo mkdir -p /opt/dosewise && sudo chown "$USER" /opt/dosewise
git clone <your-repo-url> /opt/dosewise
cd /opt/dosewise/services/hermes && uv sync
# copy your .env to /opt/dosewise/.env (rotated keys — don't reuse leaked ones)
```

## 3. Start both processes under PM2

```bash
cd /opt/dosewise
pm2 start services/hermes/deploy/pm2/ecosystem.config.js
pm2 status
```

You should see `hermes` and `hermes-git-sync` both `online`.

## 4. Make PM2 itself survive a VPS reboot

```bash
pm2 save            # snapshot the current process list
pm2 startup         # prints a sudo command — copy/paste and run it once
```

## 5. Your day-to-day loop (default: editing directly on the VPS)

```bash
ssh you@your-vps
tmux new -s dosewise         # or: tmux attach -t dosewise
cd /opt/dosewise
claude                       # Claude Code, working on the live files
```
Save a file → `hermes` (running under PM2 with `HERMES_RELOAD=1`) notices and
restarts itself in ~1s. No push, no PM2 restart, no second process. Detach with
`Ctrl-b d` any time — `hermes` and your tmux session both keep running; reattach
later with `tmux attach -t dosewise`.

When you want a durable backup / version history:
```bash
git add -A && git commit -m "..." && git push
```

## Watching it work

```bash
pm2 logs hermes    # server output — restarts, agent turns, tool calls
pm2 monit          # live dashboard
```

**Health smoke-check** (the server exposes `/health`):

```bash
curl -s http://127.0.0.1:8000/health    # -> {"status":"ok","service":"hermes"}
```

PM2 has no built-in HTTP health probe, so run that curl after `pm2 start`/`restart`
(or wire it into a cron / uptime check). A non-`ok` response with `hermes` shown
`online` in `pm2 status` means the process is up but the app failed to serve —
check `pm2 logs hermes`.

## tmux note

tmux is for keeping your **interactive SSH + Claude Code session** alive across
disconnects — it is not what keeps `hermes` running. PM2 does that,
independent of tmux, your SSH connection, and VPS reboots (once you've run
`pm2 save` + `pm2 startup`, step 4 above).

## Config knobs (env vars, set before `pm2 start` or edit ecosystem.config.js)

| Var | Default | Purpose |
|---|---|---|
| `REPO_DIR` | `/opt/dosewise` | Repo location on the VPS |
| `GIT_BRANCH` | `main` | Branch the watcher tracks |
| `POLL_SECONDS` | `15` | How often it checks for new commits |
| `RUN_TESTS` | `1` | Gate the auto-restart on a green offline test suite. A failed commit is pulled to disk but **not** activated (the running process keeps serving the previous code). Set `0` to restart unconditionally. |

**Reminders** run in-process inside `hermes` (a background task started by the
FastAPI lifespan when Telegram is enabled) — there is no separate PM2 app for them.
It DMs elders about due doses and alerts caregivers on missed critical doses over
Telegram. Tune with `REMINDERS_ENABLED`, `REMINDER_POLL_SECONDS`,
`MISSED_DOSE_MINUTES` in `.env`.

## Syncing `.env` to the VPS (secrets — out of band from git)

`.env` is **git-ignored on purpose**, so `hermes-git-sync` (which pulls code) never
carries your secrets like `MONGODB_URI`. Push them straight from your laptop to the
VPS over SSH instead — they never touch git, GitHub, or an AI chat.

**One-off push** (run on your laptop, from the repo root):
```bash
VPS_SSH=you@your-vps ./services/hermes/deploy/pm2/sync-env.sh
```
It `rsync`s `.env` to `/opt/dosewise/.env` (mode `600`) and `pm2 restart hermes` so
the new values load. `rsync` prints only the filename, never the file body.

**Auto-sync on every edit** (mirror the code flow, but for secrets) — run a PM2 app
**on your laptop** that watches `.env` and pushes on change:
```bash
VPS_SSH=you@your-vps pm2 start services/hermes/deploy/pm2/ecosystem.laptop.config.js
pm2 save
```

| Var | Default | Purpose |
|---|---|---|
| `VPS_SSH` | — (required) | SSH target, `user@host` |
| `VPS_REPO_DIR` | `/opt/dosewise` | Repo path on the VPS |
| `POLL_SECONDS` | `10` | Watcher check interval (laptop) |
| `RESTART` | `1` | `pm2 restart hermes` after a push (`sync-env.sh`) |

**Keeping secrets out of the AI chat / this repo:**
- `.env` stays git-ignored; only `.env.example` (no values) is committed.
- A repo deny rule (`.claude/settings.json`) blocks the assistant's file reader from
  opening `.env`. Never ask it to `cat`/print `.env`, and never paste keys into chat.
- The sync path is laptop → VPS over SSH only — the assistant never handles the file.
- Rotate any key that has ever been pasted into a chat or a log; treat it as burned.

> Editing directly on the VPS instead? Then `.env` already lives there — just edit
> it in place (`nano /opt/dosewise/.env`) and `pm2 restart hermes`. No sync needed.

## Useful commands

```bash
pm2 restart hermes           # manual restart
pm2 stop hermes-git-sync     # pause auto-pull (e.g. mid hotfix)
pm2 start hermes-git-sync    # resume it
pm2 delete hermes hermes-git-sync   # tear down both
```
