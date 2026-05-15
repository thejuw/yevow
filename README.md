# Sovereign-Sigma

Sovereign-Sigma is a Cloudflare-native trading engine and command center.

- Core: Cloudflare Worker plus Durable Object trading engine
- Ingest: Cloudflare Worker market-data stream ingestor
- Executioner: Cloudflare Worker exchange adapter
- UI: Next.js static export deployed to Cloudflare Pages
- Storage: D1 for audit/trade logs, KV for global config and risk controls

## Live Surfaces

- API: `https://api.yevow.co`
- Command Center: `https://app.yevow.co`
- Settings Console: `https://app.yevow.co/settings`
- Ingest Worker: `https://sovereign-sigma-ingest.woveyyevow.workers.dev`
- Executioner Worker: `https://sovereign-sigma-executioner.woveyyevow.workers.dev`

## Local Validation

```bash
npm ci
npm ci --prefix web
npm run typecheck
npm run web:typecheck
npm run web:build
npx wrangler deploy --dry-run
npx wrangler deploy --config wrangler.ingest.toml --dry-run
npx wrangler deploy --config wrangler.executioner.toml --dry-run
```

## GitHub Deployment

GitHub CI and manual Cloudflare deployment workflows live in `.github/workflows`.

See `docs/github-cloudflare-setup.md` for the GitHub Secrets, production environment, and deployment flow.

Alerting setup and verification lives in `docs/alerting-setup.md`.

## Safety Defaults

The repository is designed to fail closed:

- `TRADING_ENABLED` should stay false until intentionally enabled through the authenticated admin API.
- `EXCHANGE_ORDER_TEST_MODE` is true by default for Binance.US execution validation.
- No API credentials or runtime secrets belong in source control.
- Runtime secrets should live in Cloudflare Worker Secrets when possible; the Settings Console can stage encrypted `RISK_VAULT` credentials for operator rotation workflows, and execution uses env secrets first with vault fallback.
