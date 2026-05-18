# Cascade Recovery Runbook

This runbook is for operating the cascade recovery strategy without weakening the existing market-making safety layer.

## Default Posture

- `STRATEGY_MODE=OFF`
- `CASCADE_TAKER_ENABLED=false`
- `SHADOW_MODE=true`
- `EXCHANGE_ORDER_TEST_MODE=true`

No live cascade IOC execution should occur in this posture.

## Enable Paper Cascade Recovery

1. Open the Settings Console.
2. Set `STRATEGY_MODE=CASCADE_RECOVERY`.
3. Keep `CASCADE_TAKER_ENABLED=false`.
4. Apply the change with high-impact confirmation.
5. Verify `/admin/live-readiness` and the dashboard cascade panels.

The gateway records the cascade paper arming timestamp in KV as `cascade:paper_armed_at`.

## Paper-Mode Evidence Required Before Live

The gateway refuses `STRATEGY_MODE=BOTH_LIVE` or `CASCADE_TAKER_ENABLED=true` unless all checks pass:

- Cascade paper mode has been armed for at least `CASCADE_LIVE_READINESS_MIN_DAYS_PAPER`.
- At least `CASCADE_LIVE_READINESS_MIN_PAPER_TRADES` cascade paper trades exist.
- Cascade paper PnL is at least `CASCADE_LIVE_READINESS_MIN_PAPER_PNL_R` R units.
- No cascade-specific config changed in the last 72 hours.
- A distinct READ token approved promotion within 5 minutes of the WRITE token.

The approval endpoint is:

```bash
curl -X POST "https://api.yevow.co/admin/live-readiness/approve" \
  -H "Authorization: Bearer <READ_TOKEN>"
```

Then perform the live promotion with a separate WRITE token and high-impact confirmation.

## Two-Person Rule

The same token or subject cannot approve and execute live promotion. Use separate JWT subjects, for example:

- `operator-read`
- `operator-write`

The system checks JWT JTI, subject, scopes, and the 5-minute approval window.

## Alert Routing

| Event                          | Priority | Route                                    |
| ------------------------------ | -------- | ---------------------------------------- |
| `CASCADE_DETECTED`             | LOW      | Dashboard only                           |
| `CASCADE_ABSORPTION_CONFIRMED` | MEDIUM   | Dashboard and log                        |
| `SIGNAL_EMITTED`               | MEDIUM   | Dashboard and log                        |
| `POSITION_OPENED`              | HIGH     | Dashboard, log, Discord/Telegram/webhook |
| `STOP_HIT`                     | HIGH     | Dashboard, log, Discord/Telegram/webhook |
| `TIME_STOP_HIT`                | HIGH     | Dashboard, log, Discord/Telegram/webhook |
| `LOSS_LIMIT_BREACHED`          | CRITICAL | All channels and manual unblock          |
| `DRAWDOWN_LIMIT_BREACHED`      | CRITICAL | All channels and manual unblock          |
| `HEAT_CAP_EXCEEDED`            | CRITICAL | All channels and manual unblock          |

## Emergency Disable

1. Set `STRATEGY_MODE=OFF`.
2. Set `CASCADE_TAKER_ENABLED=false`.
3. Keep or set `TRADING_ENABLED=false` if broader trading should stop.
4. Manually close open cascade positions from the dashboard only after checking the BBO and spread.
5. Confirm no open cascade positions remain at `/admin/cascade/positions`.

## Post-Cascade Review

For each position, review:

- Detector context: notional, z-score, direction, price move ATR.
- Absorption criteria: price hold, taker exhaustion, CVD reversal, OI stabilization.
- Entry trigger: structural, VWAP, or impulsive reclaim.
- Risk: R distance, heat after entry, position notional, stop distance.
- Execution quality: fill ratio, slippage, adverse selection, fees.

Do not promote to live if the paper sample is small, clustered around a single event, or profitable only because of unrealistic fills.

## Backtest Procedure

Use the built-in `/admin/backtest/cascade` endpoint or local test fixtures with historical 1m candles. The October 2025 deleveraging replay acceptance requires operator-supplied data; the repository does not invent historical outcomes.

Expected validation:

- Multiple distinct cascade events detected.
- At least three emitted signals that close profitably in replay.
- Heat cap limits concurrent risk.
- Strategy mode cycles through `OFF -> CASCADE_RECOVERY -> BOTH_SHADOW -> BOTH_LIVE` without corrupting state.
