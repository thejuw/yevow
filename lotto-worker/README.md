# RabbitHoleTX Cloud Data Worker

This isolated Cloudflare Worker powers the live-data status layer for Yevow LOTTO. It stores canonical draw history in D1, archives every official Texas Lottery export by SHA-256 in R2, and refreshes one of the 17 configured sources every 30 minutes. It cannot predict a drawing; it preserves evidence, detects layout drift, and publishes read-only historical data.

## Boundaries

- Worker: `sovereign-sigma-lotto`
- API: `https://lotto-api.yevow.co/api/lotto/v1`
- D1: `RABBITHOLE_TX`
- R2: `yevow-rabbitholetx-raw`
- Official input only: the configured `texaslottery.com` CSV exports
- No HTTP mutation, ingest, teardown, or administrative endpoint

The existing `sovereign-sigma-core` trading Worker and its databases are deliberately untouched.

## Local verification

```bash
npm ci
npm run types
npx wrangler d1 migrations apply RABBITHOLE_TX --local
npm run check
```

Test the Cron handler locally with `npx wrangler dev --test-scheduled`, then request `/__scheduled?cron=*%2F30+*+*+*+*`.

## Production release

Wrangler does not apply D1 migrations during a Worker deploy. Apply migrations first, then deploy with strict configuration checking:

```bash
npx wrangler d1 migrations apply RABBITHOLE_TX --remote
npx wrangler deploy --strict
```

Bootstrap data is generated locally from the validated Python RabbitHoleTX database with `scripts/export_bootstrap.py`. The generated SQL and immutable raw-file manifest are release artifacts and are intentionally not committed.

## Read-only endpoints

- `GET /healthz`
- `GET /api/lotto/v1/health`
- `GET /api/lotto/v1/manifest`
- `GET /api/lotto/v1/status`
- `GET /api/lotto/v1/games`
- `GET /api/lotto/v1/games/:game/draws?limit=50&cursor=...`
- `GET /api/lotto/v1/games/:game/latest`

Responses are versioned, paginated where necessary, and CORS-limited to Yevow and its Pages previews. Failed downloads retry with backoff and use the last validated R2 object without representing that fallback as a fresh upstream fetch.
