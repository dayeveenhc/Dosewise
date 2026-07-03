# PM2 deployment (no Mutagen, no Docker)

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

## Useful commands

```bash
pm2 restart hermes           # manual restart
pm2 stop hermes-git-sync     # pause auto-pull (e.g. mid hotfix)
pm2 start hermes-git-sync    # resume it
pm2 delete hermes hermes-git-sync   # tear down both
```
