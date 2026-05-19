# Sovereign-Sigma Operator Runbook

## Daily Checks

1. Open the command center and confirm `SHADOW_MODE=true` unless a live enablement review is in progress.
2. Review `/admin/diagnostics` for L1 sync, D1 latency, secret valuation, memory layout, and Moltworker heartbeat.
3. Check trade history, paper ledger PnL, drawdown, and execution quality.
4. Confirm BTC/HYPE cascade settings match the current operating plan.
5. Review WARN/ERROR logs before changing parameters.

## Cascade Enablement

1. Keep `TRADING_ENABLED=false`.
2. Run cascade in paper mode until live-readiness gates pass.
3. Confirm the last backtest/replay report is positive.
4. Confirm the minimum paper-trading days and paper-trade count are satisfied.
5. Use the two-person approval flow before enabling live cascade taker execution.
6. Enable live mode only after `EXCHANGE_ORDER_TEST_MODE=false`, `SHADOW_MODE=false`, and all readiness checks pass.

## Kill Switch

Use the system kill-switch when:

- L1 sync desynchronizes.
- Platform health is degraded or halted.
- D1 audit latency blocks reliable journaling.
- Secret valuation fails.
- Unexpected live fills, duplicate fills, or signature errors appear.

The master halt action should require the `system:kill-switch` scope. After halting, preserve logs and export the incident window before clearing state.

## JWT Revocation

For a leaked token:

1. Call `POST /admin/auth/revoke` with `{ "jti": "<token-jti>", "reason": "leaked-token" }`.
2. To revoke every active token for a subject, call `POST /admin/auth/revoke-all-for-subject`.
3. Verify with `GET /admin/auth/revoked`.
4. Rotate `JWT_SECRET` if there is any chance the signing secret was exposed.

## Platform Health Response

If Hyperliquid platform health degrades:

1. Stop new entries.
2. Preserve position management and stop handling.
3. For HYPE, flatten only through the dedicated platform-health path after confirming the halt condition.
4. Clear platform health only after the fee-rate, liquidation, and 5xx metrics normalize.

## Rollback

- Strategy rollback: set `STRATEGY_MODE=OFF` or restore the previous StrategyVault version.
- Config rollback: use the Settings page or `POST /admin/config` with the last known-good values.
- Worker rollback: redeploy the previous Git commit or Cloudflare Worker version.
- Data rollback: do not mutate trade/audit tables; add corrective records instead.

## Incidents

- Stuck position: halt new entries, verify exchange position, and reconcile local `orderMap`.
- Missing fill: check execution reports, D1 `trades`, and Hyperliquid fills.
- Duplicate fill: revoke live mode, inspect idempotency ledger, and reconcile PnL.
- Signature mismatch: halt execution, verify `HL_AGENT_ADDRESS` derives from `HL_AGENT_SECRET`, then rotate if needed.
