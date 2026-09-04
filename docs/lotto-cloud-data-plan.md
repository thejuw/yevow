# LOTTO Cloud Data Plan

## Objective

Add a Cloudflare-native data plane for the Yevow LOTTO dashboard without changing the existing trading Worker or its databases. The new service ingests only configured, official Texas Lottery CSV exports, retains immutable source evidence, exposes read-only public status/history APIs, and never presents historical data as a prediction.

## Deployment boundary

- Worker: `sovereign-sigma-lotto`
- Public API: `https://lotto-api.yevow.co/api/lotto/v1`
- D1: `RABBITHOLE_TX`
- R2: `yevow-rabbitholetx-raw`
- Cron: one oldest-source refresh every 30 minutes, rotating across all 17 official exports
- Pages: the existing `sovereign-sigma-command-center` remains a separate static deployment

This isolation prevents a lottery-data failure from touching trading, execution, authentication, or the existing dashboard origin.

## Data contract

The Worker carries the same eight game/source matrix and historical parser eras as the Python RabbitHoleTX oracle:

- Lotto Texas, Texas Two Step, Cash Five, Powerball, and Mega Millions: one export each
- Pick 3, Daily 4, and All or Nothing: morning, day, evening, and night exports

Every source has a stable source ID, exact official URL, session, accepted physical row widths, and game-specific era rules. A record is uniquely identified by `(game, draw_date, session)`.

## Ingestion lifecycle

1. Select the least-recently-attempted configured source.
2. Fetch with bounded retries and backoff, a strict byte cap, and explicit HTML/empty-response rejection.
3. If the network fails, load the last validated immutable R2 object and record a cache fallback.
4. Hash the complete bytes with SHA-256 and save them under a digest-addressed R2 key.
5. Parse each physical CSV line independently so a malformed quote cannot consume later records.
6. Quarantine isolated row failures. Abort loudly when failures dominate, the invalid tail is consecutive, the latest date regresses, or a candidate would retire too much history.
7. Compare normalized record fingerprints with D1 and write only new, corrected, reactivated, or retired rows.
8. Advance source state only after all writes succeed. A partial failure leaves the previous published source revision in place and is safe to retry.

## D1 schema

- `lotto_sources`: configured source registry and current validated revision
- `lotto_ingestions`: immutable run ledger with counts, trigger, fallback status, and errors
- `lotto_draws`: canonical active/retired draw records with ordered values and source provenance
- `lotto_quarantine`: malformed physical rows tied to an ingestion run
- `lotto_audit_snapshots`: versioned JSON/Markdown audit artifacts for subsequent statistical refresh work

Checked-in migrations are the schema source of truth. Initial historical data is exported from the already-validated Python SQLite oracle and imported with Wrangler before the Worker is promoted.

## Public API

- `GET /healthz`
- `GET /api/lotto/v1/manifest`
- `GET /api/lotto/v1/status`
- `GET /api/lotto/v1/games`
- `GET /api/lotto/v1/games/:game/draws?limit=&cursor=`
- `GET /api/lotto/v1/games/:game/latest`

The API is read-only, validates every path/query value, caps pagination, emits revision-aware cache headers, and allows CORS only for Yevow and the Pages production/preview domains. There is no public ingestion or teardown endpoint.

## Release gates

1. Parser parity tests for every current and historical format, malformed-row quarantine, HTML rejection, schedule anomalies, and schema drift.
2. D1/R2 integration tests in the Workers runtime for idempotency, corrections, retirement guards, fallback, and API pagination.
3. Type generation, strict TypeScript, formatting, and Wrangler dry-run validation.
4. Create isolated D1/R2 resources, apply migrations, upload immutable source files, and import validated history.
5. Deploy the Worker, execute a controlled first refresh, and verify all eight counts/dates against the Python oracle.
6. Connect the LOTTO overview to the public status endpoint, rebuild Pages, preview it, then promote only after production browser checks pass.
