# Alerting Channel Setup

Sovereign-Sigma supports three alert delivery channels:

- Discord webhook: `DISCORD_WEBHOOK_URL`
- Telegram bot: `TELEGRAM_BOT_TOKEN` plus `TELEGRAM_CHAT_ID`
- Generic JSON webhook: `ALERT_WEBHOOK_URL`

At least one channel should be configured before live trading is enabled.

## Provision Secrets

Core Worker:

```bash
npx wrangler secret put DISCORD_WEBHOOK_URL
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put ALERT_WEBHOOK_URL
```

Ingest Worker:

```bash
npx wrangler secret put DISCORD_WEBHOOK_URL -c wrangler.ingest.toml
npx wrangler secret put TELEGRAM_BOT_TOKEN -c wrangler.ingest.toml
npx wrangler secret put TELEGRAM_CHAT_ID -c wrangler.ingest.toml
npx wrangler secret put ALERT_WEBHOOK_URL -c wrangler.ingest.toml
```

## Verify

From the Command Center:

1. Authenticate.
2. Open `Alerting Channel`.
3. Confirm at least one channel is `ARMED`.
4. Click `Test Alert`.

API equivalent:

```bash
curl -sS https://api.yevow.co/admin/alerts \
  -H "Authorization: Bearer $JWT"

curl -sS https://api.yevow.co/admin/alerts/test \
  -X POST \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"priority":"HIGH","title":"Sovereign-Sigma alert route test","message":"Manual alert test"}'
```

## Events That Alert

- Stream disconnect and reconnect attempts from the ingest worker.
- Stream recovery after order-book reset.
- Stale-data quote kill switch.
- Drawdown kill switch.
- Emergency anomaly pause.
- Execution jitter entering or leaving unstable mode.
- Manual `TRADING_ENABLED` changes through `/admin/config`.
