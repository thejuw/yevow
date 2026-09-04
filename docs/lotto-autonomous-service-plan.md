# RabbitHoleTX autonomous service plan

## Mission boundary

RabbitHoleTX will generate reproducible, split-risk-aware ticket sets before configured draw days, persist them once, and deliver the persisted result through Hermes. It will not predict a drawing, describe a number as due, or generate a second set for the dashboard. Every dashboard card and every delivery includes the standing **optimized, not predicted** disclaimer.

## Production topology

1. The existing `sovereign-sigma-lotto` Cloudflare Worker remains the isolated data plane.
2. A ten-minute Cron Trigger advances one bounded unit of work. Beginning at 06:00 America/Chicago it refreshes official exports for the next due game, checks database invariants and source freshness, generates a seeded coverage set, and commits the run, tickets, summary, and delivery outbox record to D1 in one transaction. Starting at 06:00 leaves enough ten-minute slots for all six Wednesday games plus three complete attempt waves before the 09:00 operating SLA.
3. Yevow-login-protected read endpoints expose current persisted picks and immutable generation logs. They never generate on request, and exact picks are not public.
4. A local Hermes bridge claims one delivery with a short lease through a bearer-authenticated service endpoint, sends the stored message with `hermes send`, and reports success or failure. A local idempotency ledger prevents a rerun from sending a delivery ID twice. Primary delivery is Photon/iMessage; Telegram is the configured fallback alert path.
5. After login, Yevow LOTTO sends its existing session JWT to the protected picks API and renders the exact stored tickets, draw date, coverage, EV, freshness, seed/log link, and disclaimer. The browser never receives the bridge service token.

This split is deliberate: Cloudflare can run continuously and owns the durable schedule, while Photon is a persistent Hermes gateway integration that must send from the user's existing Hermes host.

## Schedule policy

The service evaluates dates in `America/Chicago` and targets generation beginning at 06:00 local time so every game and all three attempt waves can complete by the 09:00 operating SLA. The SLA is not a hard cutoff: a missed invocation or transient failure remains eligible on later ten-minute ticks, including after 09:00, until it succeeds or reaches its terminal alert state. Uniqueness constraints make catch-up safe and prevent duplicate pick sets or texts.

| Game | Configured generation days | Slot |
|---|---|---|
| Lotto Texas | Monday, Wednesday | daily |
| Texas Two Step | Monday, Thursday | daily |
| Cash Five | Monday-Saturday | daily |
| Powerball | Wednesday, Saturday | daily |
| Mega Millions | Tuesday, Friday | daily |
| Pick 3 | Monday-Saturday | daily set |
| Daily 4 | Monday-Saturday | daily set |
| All or Nothing | Monday-Saturday | morning only by default |

Enabled games, schedule, EV assumptions, and ticket count are versioned in D1's `lotto_game_config`. In this service, “daily” means every official Texas draw day; Pick 3, Daily 4, and All or Nothing do not draw Sunday. Autonomous digit games are restricted to straight play so the persisted per-ticket EV remains correct for every digit pattern. The initial production selection is all eight games with four tickets per game. Operators change future runs with authenticated D1 tooling; the public static dashboard has no service secret and cannot mutate configuration.

Delivery cadence and archive freshness are separate. Before a Monday Lotto Texas set, freshness
must include the official Saturday drawing; before a Wednesday Powerball set, it must include the
official Monday drawing. A delivery day omitted by Phase 3 never permits the next run to skip that
official result.

## Authentication boundary

- `GET /api/lotto/v1/picks/today` and `GET /api/lotto/v1/generation-runs/:runId` require an existing Yevow login JWT. The Worker validates that JWT through the Yevow core authentication service.
- `POST /api/lotto/v1/automation/run`, `POST /api/lotto/v1/deliveries/claim`, and `POST /api/lotto/v1/deliveries/:deliveryId/result` require the separate `RABBITHOLETX_SERVICE_TOKEN` bearer credential.
- `RABBITHOLETX_SEED_SALT` is a separate, stable, random Worker secret of at least 32 characters. It HMAC-protects deterministic daily seeds and is never copied to the browser or Hermes host. Rotating it changes future regenerated sets.
- Public health, manifest, and game-history endpoints expose neither exact picks nor credentials. Authoritative per-game service status requires the service bearer token.
- The Yevow frontend receives only the user's session JWT. `RABBITHOLETX_SERVICE_TOKEN` remains in the Cloudflare secret store and the protected Hermes host environment.

## Data model and idempotency

- `lotto_generation_runs` has a unique natural key of `(game, draw_date)` and stores the HMAC-protected deterministic daily seed, selected slot, data cutoff/digest, timestamps, coverage, EV, and terminal error.
- `lotto_generated_tickets` stores ordered ticket rows under a run.
- `lotto_delivery_outbox` has exactly one primary delivery per run and leased claim fields for concurrent-safe polling. `lotto_delivery_attempts` is the append-only confirmation and retry audit trail.
- `lotto_daily_summaries` records aggregate ingestion, quarantine, generation, delivery, and alert state.
- A run inserted twice reuses the committed row. The seed is an HMAC of a versioned `game + draw date + slot` namespace under `RABBITHOLETX_SEED_SALT`; it rotates daily, reproduces exactly under the same secret, and cannot be computed from public data alone.
- The Hermes bridge writes `delivery_id` state before and after the external side effect. An ambiguous interrupted send is quarantined for attention instead of being sent again.

## Pipeline and failure policy

For one due game the Worker performs:

`refresh official sources -> verify source/data invariants -> reserve run -> optimize tickets -> compute conservative per-ticket EV -> atomically publish picks and outbox -> log summary`

Downloads retain the existing three-attempt exponential backoff and validated R2 fallback. The generation pipeline retries bounded transient failures. A terminal failure is written to the run log and creates a fallback alert payload rather than silently skipping the game. Delivery receives one initial attempt plus three local retries with exponential backoff; terminal primary failure remains queued and is also reported through the fallback target.

## Hermes contract and secrets

The committed adapter invokes the existing `hermes send --json --to ...` interface and never reads transport credentials itself. The host currently has Photon/iMessage and Telegram configured. Hermes owns the existing Photon values:

- `PHOTON_PROJECT_ID`
- `PHOTON_PROJECT_SECRET`
- `PHOTON_HOME_CHANNEL`

For literal carrier SMS via the Hermes Twilio adapter, outbound delivery requires `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_PHONE_NUMBER`; bare `--to sms` also requires `SMS_HOME_CHANNEL`. `SMS_WEBHOOK_URL` is required only for inbound/two-way gateway operation. Optional inbound controls are `SMS_ALLOWED_USERS` (preferred), `SMS_ALLOW_ALL_USERS`, and `SMS_HOME_CHANNEL_NAME`.

RabbitHoleTX adds:

- `RABBITHOLETX_SERVICE_TOKEN` — required on both the Worker and Hermes host; bearer-authenticates claim/result calls.
- `RABBITHOLETX_API_BASE` — required by the bridge; production uses `https://lotto-api.yevow.co/api/lotto/v1`.
- `RABBITHOLETX_HERMES_TARGET` — optional; defaults to the currently configured `photon` text channel and can be changed to `sms` without code changes once the Hermes Twilio variables exist.
- `RABBITHOLETX_HERMES_FALLBACK_TARGET` — optional; defaults to `telegram`.
- `RABBITHOLETX_HERMES_COMMAND` — optional executable path override; defaults to `hermes`.
- `RABBITHOLETX_HOME` — optional local state directory; the versioned SQLite database inside it contains the bridge idempotency ledger.
- `RABBITHOLETX_DELIVERY_ATTEMPTS` — optional total-attempt cap; defaults to `4` (initial send plus three retries).
- `RABBITHOLETX_BACKOFF_SECONDS` — optional exponential-backoff base; defaults to `1`.

No value for any credential is committed, logged, included in a URL, or returned by an API.

Before first deploy, set the two independent Worker secrets with the active Yevow Wrangler profile:

```bash
npx wrangler secret put RABBITHOLETX_SERVICE_TOKEN
npx wrangler secret put RABBITHOLETX_SEED_SALT
```

The service token is also installed in the protected Hermes host environment. The seed salt stays
only in Cloudflare and must contain at least 32 characters.

## Verification and release gates

- Unit tests cover every schedule, DST-safe local-time evaluation, deterministic seed rotation, legality, pair coverage, D1 natural-key idempotency, delivery leasing, mocked Hermes success/retry/fallback, and API authentication.
- Dashboard tests prove displayed tickets are parsed from and identical to the persisted API payload.
- A no-network, mock-Hermes full-cycle simulation must ingest fixture data, generate, persist, claim, deliver, acknowledge, and render the same numbers twice without a duplicate send.
- Before release: schema migration, generated Worker types, TypeScript, Python type/lint/test suites, Worker dry deploy, Next static build, and Playwright all pass.
- After release: verify schema version, selected-game schedule, current picks, generation log, protected outbox, CORS, dashboard rendering, Cron trigger, and one mock delivery cycle. A live text is sent only after the service token and Hermes cron are installed.
