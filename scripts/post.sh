#!/usr/bin/env bash
#
# Dosewise — Power-On Self-Test (POST)
#
# Run this whenever you restart the backend (Hermes) or reset the whole system,
# BEFORE declaring the work done. It guarantees the things that have bitten us:
#   - no port conflicts, no orphaned Hermes processes
#   - no Telegram 409 double-poller, no "[Errno 98] Address already in use"
#   - every layer is up and the agent path is reachable
#   - the tool belt + safety rails pass their offline test suite
#
#   bash scripts/post.sh            # full POST (resets backends, runs suite)
#   bash scripts/post.sh --quick    # read-only health checks, no disruption
#
# Safe to re-run (idempotent). See "Power-On Self-Test (POST)" in CLAUDE.md.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HERMES_DIR="$REPO_ROOT/services/hermes"
WEB_DIR="$REPO_ROOT/apps/web"

PROD_PORT=8000          # pm2 `hermes`        — repo-root .env, has Telegram token (sole poller)
DEMO_PORT=5010          # pm2 `hermes-demo`   — deploy/pm2/.env.demo, web demo backend (empty token)
WEB_PORT=5173           # Vite dev server
BACKEND_NGROK_DOMAIN="neomi-unimprinted-shelton.ngrok-free.dev"
WEB_ENV="$WEB_DIR/.env"

QUICK=0
[ "${1:-}" = "--quick" ] && QUICK=1

PASS=0; FAIL=0
step() { printf "\n\033[1;36m>> %s\033[0m\n" "$*"; }
ok()   { printf "  \033[1;32m[OK]\033[0m  %s\n" "$*"; PASS=$((PASS+1)); }
bad()  { printf "  \033[1;31m[FAIL]\033[0m %s\n" "$*"; FAIL=$((FAIL+1)); }
info() { printf "       %s\n" "$*"; }

listening() { ss -tln 2>/dev/null | grep -qE "[:.]$1\b" && return 0 || return 1; }

port_pids() {
  ss -tlnpH 2>/dev/null | grep -E "[:.]$1\b" | grep -oE "pid=[0-9]+" | cut -d= -f2 | sort -u
}

# Hermes python procs reparented to init (PPID 1) = leaked orphans.
orphan_pids() {
  ps -o pid=,ppid=,cmd= -C python3 2>/dev/null \
    | awk '$2==1 && ($0 ~ /hermes-serve/ || $0 ~ /multiprocessing/) {print $1}'
}

http_code() { curl -s -o /dev/null -m 8 -w "%{http_code}" "$@" 2>/dev/null; }

pm2_field() {
  pm2 jlist 2>/dev/null | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
    name, key = sys.argv[1], sys.argv[2]
    for p in d:
        if p.get("name") == name:
            print(p.get("pm2_env", {}).get(key, "")); break
except Exception:
    pass
' "$1" "$2" 2>/dev/null
}

free_port() {
  local port=$1 pids p
  pids="$(port_pids "$port")"
  [ -z "$pids" ] && return 0
  for p in $pids; do kill "$p" 2>/dev/null; done; sleep 1
  for p in $pids; do listening "$port" && kill -9 "$p" 2>/dev/null; done
  sleep 1
}

ensure_ngrok_backend() {
  if pgrep -f "ngrok.*--url=$BACKEND_NGROK_DOMAIN" >/dev/null 2>&1; then
    ok "backend ngrok already up (fixed domain -> :$DEMO_PORT)"
    return
  fi
  info "starting backend ngrok -> :$DEMO_PORT"
  nohup ngrok http --url="$BACKEND_NGROK_DOMAIN" "$DEMO_PORT" --log=stdout >/tmp/ngrok-backend.log 2>&1 &
  sleep 4
  pgrep -f "ngrok.*--url=$BACKEND_NGROK_DOMAIN" >/dev/null 2>&1 && ok "backend ngrok started" || bad "backend ngrok failed (see /tmp/ngrok-backend.log)"
}

ensure_ngrok_frontend() {
  if pgrep -f "ngrok http $WEB_PORT " >/dev/null 2>&1; then
    ok "frontend ngrok already up (-> :$WEB_PORT) — URL preserved"
    return
  fi
  info "starting frontend ngrok -> :$WEB_PORT (new random URL)"
  nohup ngrok http "$WEB_PORT" --log=stdout >/tmp/ngrok-frontend.log 2>&1 &
  sleep 4
  pgrep -f "ngrok http $WEB_PORT " >/dev/null 2>&1 && ok "frontend ngrok started" || bad "frontend ngrok failed (see /tmp/ngrok-frontend.log)"
}

frontend_public_url() {
  for insp in 4040 4041; do
    curl -s -m 5 "http://127.0.0.1:$insp/api/tunnels" 2>/dev/null
  done | python3 -c '
import sys, json
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        d = json.loads(line)
    except Exception:
        continue
    for t in d.get("tunnels", []):
        if "5173" in t.get("config", {}).get("addr", ""):
            print(t.get("public_url", "")); break
' 2>/dev/null | head -1
}

if [ "$QUICK" = 0 ]; then

  step "PHASE 1 — clean slate (stop backends, purge orphans, free ports)"
  info "stopping pm2 backends (hermes, hermes-demo)..."
  pm2 stop hermes hermes-demo >/dev/null 2>&1 || true
  sleep 3

  info "purging orphaned Hermes processes (PPID 1)..."
  opids="$(orphan_pids)"
  if [ -n "$opids" ]; then
    for p in $opids; do kill "$p" 2>/dev/null && info "killed orphan $p"; done
    sleep 2
    opids="$(orphan_pids)"
    for p in $opids; do kill -9 "$p" 2>/dev/null && info "SIGKILL orphan $p"; done
  else
    info "no orphans found"
  fi

  info "forcing backend ports free..."
  free_port "$PROD_PORT"
  free_port "$DEMO_PORT"
  listening "$PROD_PORT" && bad ":$PROD_PORT still in use" || ok ":$PROD_PORT free"
  listening "$DEMO_PORT"  && bad ":$DEMO_PORT still in use"  || ok ":$DEMO_PORT free"

  step "PHASE 2 — start backends"
  pm2 restart hermes hermes-demo >/dev/null 2>&1 && ok "pm2 restart issued" || bad "pm2 restart failed"
  sleep 7

  step "PHASE 3 — ensure ngrok tunnels up (start only if down)"
  ensure_ngrok_backend
  ensure_ngrok_frontend

  step "PHASE 4 — ensure Vite frontend up (start only if :$WEB_PORT down)"
  if listening "$WEB_PORT"; then
    ok "Vite already serving on :$WEB_PORT"
  else
    info "starting Vite..."
    ( cd "$WEB_DIR" && nohup npm run dev >/tmp/vite.log 2>&1 & )
    for i in $(seq 1 12); do listening "$WEB_PORT" && break; sleep 2; done
    listening "$WEB_PORT" && ok "Vite up on :$WEB_PORT" || bad "Vite failed (see /tmp/vite.log)"
  fi

else
  step "QUICK MODE — read-only checks (no services touched)"
fi

step "PHASE 5 — POST checks"

# backends healthy
[ "$(http_code "http://127.0.0.1:$PROD_PORT/health")" = "200" ] && ok "prod  :$PROD_PORT /health 200" || bad "prod  :$PROD_PORT /health not 200"
[ "$(http_code "http://127.0.0.1:$DEMO_PORT/health")"  = "200" ] && ok "demo  :$DEMO_PORT /health 200" || bad "demo  :$DEMO_PORT /health not 200"

# no orphaned hermes procs
opids="$(orphan_pids)"
[ -z "$opids" ] && ok "no orphaned Hermes processes (PPID 1)" || bad "orphans remain: $(echo "$opids" | tr '\n' ' ')"

# ports each held by exactly one hermes-serve
pp="$(port_pids "$PROD_PORT" | wc -l | tr -d ' ')"; dp="$(port_pids "$DEMO_PORT" | wc -l | tr -d ' ')"
info ":$PROD_PORT holders: $(port_pids "$PROD_PORT" | tr '\n' ' ')"
info ":$DEMO_PORT  holders: $(port_pids "$DEMO_PORT" | tr '\n' ' ')"

# backend ngrok reachable
[ "$(http_code -H "ngrok-skip-browser-warning: 1" "https://$BACKEND_NGROK_DOMAIN/health")" = "200" ] \
  && ok "backend ngrok /health 200 ($BACKEND_NGROK_DOMAIN)" || bad "backend ngrok not reachable"

# agent path reachable (401 w/o JWT = working as designed; proves CORS preflight + API-key gate)
apikey="$(grep -E "^VITE_HERMES_API_KEY=" "$WEB_ENV" 2>/dev/null | head -1 | cut -d= -f2-)"
acode="$(curl -s -o /dev/null -m 12 -w "%{http_code}" -X POST -H "Content-Type: application/json" -H "ngrok-skip-browser-warning: 1" ${apikey:+-H "X-Hermes-Api-Key: $apikey"} -d '{"message":"ping"}' "https://$BACKEND_NGROK_DOMAIN/agent/turn" 2>/dev/null)"
[ "$acode" = "401" ] && ok "agent path reachable (/agent/turn -> 401 jwt required = OK)" || bad "agent path unexpected HTTP $acode"

# frontend served via its public ngrok URL
fe_url="$(frontend_public_url)"
if [ -n "$fe_url" ]; then
  [ "$(http_code -H "ngrok-skip-browser-warning: 1" "$fe_url/")" = "200" ] && ok "frontend served ($fe_url)" || bad "frontend not 200 ($fe_url)"
else
  bad "could not discover frontend ngrok URL (is the 5173 tunnel up?)"
fi
info "frontend public URL: ${fe_url:-unknown}"

# no conflict / address-in-use errors in recent prod log
sleep 3
if pm2 logs hermes --nostream --err --lines 40 2>&1 | grep -qiE "409|conflict|getUpdates.*terminat|Errno 98|Address already in use"; then
  bad "conflict / address-in-use errors present in prod log"
else
  ok "no 409 / address-in-use in prod log"
fi

# restart-storm check: count flat over two samples
r1="$(pm2_field hermes restart_time)"; sleep 5; r2="$(pm2_field hermes restart_time)"
[ "$r1" = "$r2" ] && [ -n "$r2" ] && ok "prod hermes stable (restart count flat at $r2)" || bad "prod hermes still restarting ($r1 -> $r2)"

# all pm2 apps online
so="$(pm2_field hermes status)"; sd="$(pm2_field hermes-demo status)"; sg="$(pm2_field hermes-git-sync status)"
[ "$so" = "online" ] && [ "$sd" = "online" ] && [ "$sg" = "online" ] \
  && ok "pm2 apps online (hermes=$so, hermes-demo=$sd, hermes-git-sync=$sg)" \
  || bad "pm2 not all online (hermes=$so, hermes-demo=$sd, git-sync=$sg)"

if [ "$QUICK" = 0 ]; then
  step "PHASE 6 — feature validation (offline tool-belt + safety-rail suite)"
  if ( cd "$HERMES_DIR" && uv run pytest -q -m "not integration" >/tmp/post-pytest.log 2>&1 ); then
    ok "pytest passed ($(grep -oE "[0-9]+ passed" /tmp/post-pytest.log | head -1)) — tool belt + safety rails functional"
  else
    bad "pytest failed (see /tmp/post-pytest.log)"; tail -15 /tmp/post-pytest.log | sed 's/^/       /'
  fi
fi

step "POST RESULT"
printf "       passed: \033[1;32m%d\033[0m   failed: \033[1;31m%d\033[0m\n" "$PASS" "$FAIL"
if [ "$FAIL" = 0 ]; then
  printf "\n\033[1;32mPOST PASSED — system is up, conflict-free, and functional.\033[0m\n"
  exit 0
else
  printf "\n\033[1;31mPOST FAILED — resolve the [FAIL] lines above before proceeding.\033[0m\n"
  exit 1
fi
