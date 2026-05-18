# Cascade Validation Report

Generated: 2026-05-18

## Summary

The cascade stack is not cleared for live cascade/taker execution from the data available in this workspace. The code path now requires a positive-expectancy backtest artifact before live promotion, but a 12-month Hyperliquid liquidation/candle dataset was not available to Codex during this pass.

## Commands Run

```bash
npm run test:engine
npx wrangler d1 execute TRADING_DB --remote --command "SELECT ... FROM candles/cascade_liquidations/trades"
npx wrangler d1 execute TRADING_DB --local --command "SELECT ... FROM candles/cascade_liquidations/trades"
```

## Results

| Check                         | Result            | Notes                                                                                   |
| ----------------------------- | ----------------- | --------------------------------------------------------------------------------------- |
| Engine coverage gate          | PASS              | `120` tests pass. Coverage: statements `90.59%`, branches `80.38%`, functions `93.63%`. |
| Fixture cascade replay        | PASS              | Unit fixture produces cascade, signal, and entry without inventing missing data.        |
| Remote 12-month D1 validation | BLOCKED           | Cloudflare API returned authorization error `7403` for the configured account/database. |
| Local D1 validation           | INSUFFICIENT DATA | Local `.wrangler` database does not contain the required production tables/data.        |
| Live-readiness backtest gate  | ENFORCED IN CODE  | Promotion now requires the latest stored cascade backtest to be positive and validated. |

## Per-Asset Threshold Decision

The previous single `$50M` liquidation threshold has been replaced by per-asset cascade profiles:

| Asset  | Active By Default | Notional Gate | Z-Score | ATR Gate | Max Notional | Liquidity Cap | Slippage Guard |
| ------ | ----------------- | ------------: | ------: | -------: | -----------: | ------------: | -------------: |
| `BTC`  | Yes               |        `$50M` |   `3.0` |    `1.5` |        `25%` |        `$25k` |        `8 bps` |
| `HYPE` | Yes               |       `$2.5M` |   `3.5` |   `2.25` |         `8%` |         `$3k` |       `15 bps` |
| `ETH`  | No                |        `$25M` |   `3.0` |    `1.6` |        `18%` |        `$15k` |        `9 bps` |
| `SOL`  | No                |         `$8M` |  `3.25` |    `1.8` |        `12%` |       `$7.5k` |       `12 bps` |

HYPE is explicitly included in the production profile, but with stricter sizing and confirmation than BTC.

## Live-Readiness Gate

Cascade live promotion now fails unless all of these pass:

- Latest cascade backtest artifact has positive expectancy, positive total PnL, at least one trade, and validation `ok=true`.
- Cascade paper mode has been armed for at least `CASCADE_LIVE_READINESS_MIN_DAYS_PAPER` days.
- Cascade paper trade count is at least `CASCADE_LIVE_READINESS_MIN_PAPER_TRADES`.
- Cascade paper PnL is at least `CASCADE_LIVE_READINESS_MIN_PAPER_PNL_R`.
- Cascade config has been frozen for the required window.
- A fresh distinct READ token and WRITE token satisfy the two-person rule.

Enabling `TRADING_ENABLED=true` while `STRATEGY_MODE=CASCADE_RECOVERY` now triggers this gate, not only `BOTH_LIVE` or `CASCADE_TAKER_ENABLED=true`.

## Data Required To Finish 12-Month Validation

To publish a real equity curve, provide or authorize access to at least 12 months of:

- `candles`: 1m or finer OHLCV for BTC, HYPE, ETH, and SOL.
- `cascade_liquidations`: liquidation events with side, notional, price, and observed timestamp.
- `open_interest`: sampled open interest by instrument, or explicitly set the backtester to the documented missing-OI policy.
- `execution_quality`: slippage/adverse-selection samples if available.

Until that dataset is loaded and the backtest artifact is written to `CONFIG_STORE` key `cascade:last_backtest_report`, live cascade execution should remain locked.
