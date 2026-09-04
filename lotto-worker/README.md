# RabbitHoleTX autonomous Worker

This isolated Cloudflare Worker is the production source of truth for Yevow LOTTO. It archives
official Texas Lottery CSV exports in R2, maintains canonical history in D1, generates one
deterministic optimized set per selected game and Texas draw date, and writes the exact dashboard
and Hermes payload to a durable outbox. It does not predict drawings.

## Boundaries

- Worker: `sovereign-sigma-lotto`
- API: `https://lotto-api.yevow.co/api/lotto/v1`
- D1: `RABBITHOLE_TX`
- R2: `yevow-rabbitholetx-raw`
- Official input only: configured `texaslottery.com` CSV exports
- Generation and delivery natural key: `(game, draw_date)`
- Required Worker secrets: `RABBITHOLETX_SERVICE_TOKEN`, `RABBITHOLETX_SEED_SALT`

The existing `sovereign-sigma-core` trading Worker and its databases remain untouched. Hermes
transport credentials stay on the user's Hermes host and are never uploaded to Cloudflare.

## Schedule

The UTC Cron Trigger runs every ten minutes. The scheduler converts its supplied timestamp to
`America/Chicago`; D1 configuration starts draw-day work at 06:00. One bounded game pipeline runs
per tick, leaving enough time for all six Wednesday games and three attempt waves before 09:00.
The 09:00 time is the operating SLA, not a hard cutoff: if Cloudflare misses an invocation or a
transient dependency fails, the next ten-minute tick continues catch-up work after 09:00 until the
due run succeeds or reaches its terminal alert state. D1 uniqueness constraints make those replayed
ticks safe. Non-generation archive rotation remains limited to each UTC half-hour.

Configured generation days are Lotto Texas Mon/Wed, Texas Two Step Mon/Thu, Cash Five Mon-Sat,
Powerball Wed/Sat, Mega Millions Tue/Fri, and Pick 3, Daily 4, and All or Nothing Mon–Sat, with
the All or Nothing morning slot selected by default. Here “daily” means every official Texas draw
day; those games do not draw Sunday. Historical archive cadence is intentionally separate.
Freshness always follows the full official cadence: Monday Lotto requires Saturday's result, and
Wednesday Powerball requires Monday's result even though those intermediate days do not generate
a Phase 3 delivery.

`lotto_game_config` controls selection, ticket count, schedule, and EV inputs. Autonomous digit
games use straight play so one persisted per-ticket EV is correct for every generated digit
pattern; the interactive toolkit still supports and explains the other official play styles.
The initial migration enables all eight games with four tickets each. Future rows can be changed
with authenticated Cloudflare D1 tooling; changes affect only generation dates not yet published.

## Secrets and Hermes

Create a cryptographically random bearer token in the Worker secret store and the protected Hermes
host environment. Create a separate stable random seed salt of at least 32 characters in the
Worker secret store only:

```bash
npx wrangler secret put RABBITHOLETX_SERVICE_TOKEN
npx wrangler secret put RABBITHOLETX_SEED_SALT
```

The salt HMAC-protects deterministic daily seeds, must differ from the service token, and should
not be rotated casually: changing it changes future regenerated sets.

The local `rabbitholetx bridge` process also needs `RABBITHOLETX_API_BASE` and
`RABBITHOLETX_SERVICE_TOKEN`. Its Hermes target and retry variables are documented in the root
`docs/AUTONOMOUS_SERVICE.md`; provider credentials are owned by Hermes itself. The installed
delivery route is Photon/iMessage with Telegram as its fallback. Literal carrier SMS is not enabled
until Hermes has `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_PHONE_NUMBER`; using the
bare `sms` target also requires `SMS_HOME_CHANNEL`. Hermes makes four total send attempts by
default: the initial attempt and three retries.

## Local verification

```bash
npm ci
npm run types
npx wrangler d1 migrations apply RABBITHOLE_TX --local
npm run check
```

Test Cron locally with `npx wrangler dev --test-scheduled`, then request
`/__scheduled?cron=*%2F10+*+*+*+*`.

## Production release

Wrangler does not apply D1 migrations during deploy, so migrate first:

```bash
npx wrangler d1 migrations apply RABBITHOLE_TX --remote
npx wrangler secret put RABBITHOLETX_SERVICE_TOKEN
npx wrangler secret put RABBITHOLETX_SEED_SALT
npx wrangler deploy --strict
```

Bootstrap data is generated from the validated Python RabbitHoleTX database with
`scripts/export_bootstrap.py`. Generated SQL and raw-file manifests are release artifacts and are
not committed.

## Public endpoints

- `GET /healthz`
- `GET /api/lotto/v1/health`
- `GET /api/lotto/v1/manifest`
- `GET /api/lotto/v1/status`
- `GET /api/lotto/v1/games`
- `GET /api/lotto/v1/games/:game/draws?limit=50&cursor=...`
- `GET /api/lotto/v1/games/:game/latest`

## Yevow-login-protected dashboard endpoints

- `GET /api/lotto/v1/picks/today`
- `GET /api/lotto/v1/generation-runs/:runId`

These endpoints accept the signed Yevow session JWT as `Authorization: Bearer <jwt>` and validate
it against the Yevow core authentication service. Exact picks, seeds, and generation logs are not
public. The browser never receives `RABBITHOLETX_SERVICE_TOKEN`.

## Bearer-protected service endpoints

- `POST /api/lotto/v1/automation/run`
- `POST /api/lotto/v1/deliveries/claim`
- `POST /api/lotto/v1/deliveries/:deliveryId/result`
- `GET /api/lotto/v1/service-status`

These machine-to-machine endpoints require the `RABBITHOLETX_SERVICE_TOKEN` value in the
`Authorization: Bearer <token>` header. That credential is independent of a Yevow user JWT and
must exist only in the Worker secret store and the protected Hermes host environment.

`service-status` always returns an ingest object for every configured game, including a degraded
object when a source has never loaded. Its per-game operational fields are
`configurationValid`, `configurationError`, `generationDue`, `generationMissed`,
`pendingDeliveries`, `failedDeliveries`, `unresolvedAlerts`, `quarantinedRecords`, `lastError`, and
`attentionRequired`. Freshness is measured against each game's official draw cadence; the health
endpoint also reports `missedGenerationGames` when a selected draw-day game has no generated run
after 09:00 CT. A malformed selected configuration is isolated into a failed run and fallback
alert, while a malformed disabled configuration remains observable without stopping the service.

Responses are versioned, input bodies are bounded, CORS is limited to Yevow and Pages previews,
and no response exposes a recipient or secret. Failed downloads retry with backoff and can use
only the last validated R2 object. A malformed layout fails generation visibly and is never
silently treated as fresh data.
