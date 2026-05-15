# Sovereign-Sigma Phases 42-48 + Intelligence Upgrade Checklist

Source document preserved at `phase_42_48_source.txt`.

## Phase 42: Admin Panel Backend + Live Data Stream

- [x] Added authenticated `/admin/stream` WebSocket routing to the TradingEngine.
- [x] Added 500ms `DASHBOARD_PULSE` payloads with `total_equity`, `unrealized_pnl`, `active_drawdown`, `current_imbalance`, latency/jitter, toxicity, location, and compact sparkline data.
- [x] Reused the Durable Object broadcaster and capped in-memory signal buffers for live UI delivery.

## Phase 43: Agent CCTV + Thought Traceability

- [x] Added authenticated `/admin/trace`.
- [x] Returns the last 50 logical steps per agent when no agent filter is supplied.
- [x] Includes terminal-style feed lines and recent telemetry hub events from D1.
- [x] Preserves trace IDs, signal IDs, rationale, confidence, feature vectors, risk snapshots, and timestamps for candle correlation.

## Phase 44: Risk Command Center

- [x] Extended global risk config with `KELLY_FRACTION`.
- [x] Added config support for `MAX_POSITION_SIZE`, `MIN_EV_THRESHOLD`, and latency threshold updates through `/admin/config`.
- [x] Added high-impact confirmation enforcement for kill-switch and material risk changes.
- [x] Audit logs include actor, changed parameters, previous config, next config, colo, and placement.
- [x] Added `/admin/ui` lightweight command center with kill-switch/risk controls.

## Phase 45: Performance Attribution

- [x] Added authenticated `/admin/attribution`.
- [x] Calculates per-driver cumulative PnL, average PnL, Sharpe-style score, profit factor, trade count, gross profit/loss, and average confidence.
- [x] Returns cumulative-by-driver timeline data suitable for stacked-area PnL charts.
- [x] Extended `trades` schema and logger contract with `resulting_pnl` and `primary_driver`.

## Phase 46: Secure API + Credential Management UI

- [x] Added authenticated `/admin/vault` status endpoint with masked credential state.
- [x] Added authenticated `/admin/vault` rotation endpoint storing encrypted credential material in `RISK_VAULT`.
- [x] Added `/admin/vault/test` path that calls the Executioner balance-test endpoint.
- [x] Added `GET /account/balance` to the Executioner Worker.
- [x] Added `VAULT_ENCRYPTION_SECRET`, notifier secrets, and exchange balance endpoint config guidance.
- [x] The UI masks secret fields and avoids logging raw secret/JWT material.

## Phase 47: Time Machine UI + Replay Controls

- [x] Added date range support to `/admin/replay`.
- [x] Added `/admin/replay/status` with progress, tick totals, date range, speed multiplier, started/completed timestamps, and error state.
- [x] Replay status is broadcast over the telemetry bus as `REPLAY_PROGRESS`.
- [x] Existing shadow replay outputs preserve shadow trades, actual historical trade count, generated intent count, and theoretical PnL.
- [x] Command center includes replay controls and progress element.

## Phase 48: External Alerting

- [x] Added `src/utils/Notifier.ts`.
- [x] Supports Discord webhooks and Telegram Bot API through Worker secrets.
- [x] Implements priority levels, debouncing through KV, metadata sanitization, and non-blocking delivery through `waitUntil`.
- [x] Wired alerts into stale-data kill switch, emergency anomaly pause, drawdown kill-switch, stream disconnect/reconnect, and stream recovery.

## Phase XXX: Intelligence Upgrade

- [x] Added regime-aware Oracle governance modes: `MANUAL`, `AUTONOMOUS`, and `HYBRID`.
- [x] Added skepticism multiplier κ to Oracle state and telemetry.
- [x] Added ADX plus ATR-to-volume efficiency sensor inputs.
- [x] Ranging regimes increase skepticism; trending regimes reduce toward 1.
- [x] Bayesian updates now widen the effective evidence threshold by κ and attenuate likelihood.
- [x] VPIN/adverse-selection integration remains wired through Profiler and Croupier EV deductions.
- [x] Stale-data kill switch invalidates hot-path EV work and pulls current quotes before returning.
- [x] Telemetry includes `RegimeCoefficient` and `AgentLogicTrace`.
- [x] Replay/shadow execution remains the safe pre-live validation path.

## Verification

- [x] `npm run typecheck`
- [x] `npx wrangler deploy --dry-run --outdir /tmp/sovereign-sigma-core-check`
- [x] `npx wrangler deploy --dry-run --config wrangler.ingest.toml --outdir /tmp/sovereign-sigma-ingest-check`
- [x] `npx wrangler deploy --dry-run --config wrangler.executioner.toml --outdir /tmp/sovereign-sigma-executioner-check`
- [x] `sqlite3 :memory: < schema.sql`

## Deployment Notes

- Promote real exchange credentials with `wrangler secret` for long-lived production use.
- Use `/admin/vault` for encrypted rotation workflow and operational staging, not as a replacement for Cloudflare secret bindings.
- Wrangler emitted an out-of-date warning for the installed 3.114.17 version; bundles still passed dry-run.
