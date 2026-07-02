# Deploying Hermes to the Hostinger VPS

This is the **webhook** deployment (VPS reachable at a public HTTPS URL). Local
testing uses long-polling instead (see the top-level `services/hermes/README.md`).

> ⚠️ **Supabase reachability.** The local Supabase you test against is *not*
> reachable from the VPS. For the VPS you need a **hosted** Supabase project, and
> the seed test users must exist there (the `seed.sql` inserts into `auth.users`,
> which only works locally). Creating the test elder/caregiver on hosted Supabase
> via the Admin API is a follow-up task — until then, run the VPS against a hosted
> project whose users you've provisioned.

## 1. Prerequisites on the VPS

```bash
# Install uv (provisions Python 3.12 for us)
curl -LsSf https://astral.sh/uv/install.sh | sh
# Clone the repo
sudo mkdir -p /opt/dosewise && sudo chown "$USER" /opt/dosewise
git clone <your-repo-url> /opt/dosewise
cd /opt/dosewise/services/hermes
uv sync
```

## 2. Configure `.env` (repo root: `/opt/dosewise/.env`)

Fill in the **hosted** Supabase values, the Anthropic key, the Telegram token,
and:

```
HERMES_CHANNEL_MODE=webhook
VPS_URL=https://hermes.yourdomain.com
TELEGRAM_WEBHOOK_SECRET=<a-random-string>
```

## 3. TLS reverse proxy (Caddy)

Install Caddy, edit `deploy/Caddyfile` to your domain, then reload. Caddy
auto-provisions a Let's Encrypt certificate and forwards `:443 -> 127.0.0.1:8000`.

## 4. Run under systemd

```bash
sudo cp deploy/hermes.service /etc/systemd/system/hermes.service
# edit User / WorkingDirectory / ExecStart path if needed
sudo systemctl daemon-reload
sudo systemctl enable --now hermes
sudo journalctl -u hermes -f      # watch logs
```

On startup Hermes calls `setWebhook` against `${VPS_URL}/telegram/webhook`.

## 5. Verify

```bash
curl https://hermes.yourdomain.com/health           # -> {"status":"ok",...}
# Telegram thinks it's wired up:
curl "https://api.telegram.org/bot<token>/getWebhookInfo"
```

Then message the bot from Telegram and watch `journalctl -u hermes -f`.
