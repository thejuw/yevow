# Cascade Recovery Strategy

Sovereign-Sigma cascade recovery is a Hyperliquid-only, rule-based strategy that reacts to forced liquidation clusters and waits for evidence that the forced flow has been absorbed before entering. It is intentionally separate from the market-making path.

## State Machine

1. `OFF`
   - No cascade signals are evaluated.
2. `CASCADE_DETECTED`
   - Liquidation events are aggregated by instrument, side, notional, time window, z-score, directional concentration, and ATR price displacement.
3. `ABSORPTION_CONFIRMED`
   - Price holds near the cascade extreme and at least one exhaustion criterion confirms: taker flow decays, CVD reverses, or open interest stabilizes.
4. `SIGNAL_EMITTED`
   - A reclaim trigger passes: structural reclaim, VWAP reclaim, or impulsive reclaim bar.
5. `POSITION_OPENED`
   - Position sizing passes risk, notional, liquidity, and heat-cap checks.
6. `POSITION_MANAGED`
   - Partial exits, stop moves, runner trailing stop, and time stop are managed by the position manager.
7. `CLOSED`
   - Position is closed by target, stop, time stop, manual close, or risk limiter.

## Detector Math

Liquidation windows are evaluated per instrument. A cascade requires:

```text
notional(window) >= CASCADE_ASSET_PROFILES[asset].notionalThresholdUsd
zscore(window_notional, historical_baseline) >= CASCADE_ASSET_PROFILES[asset].zScoreThreshold
dominant_side_notional / total_notional >= CASCADE_DIRECTIONAL_PCT
abs(price_at_peak - price_at_start) / ATR_1H >= CASCADE_ASSET_PROFILES[asset].minPriceMoveAtr
```

The baseline excludes the current window so the shock does not dilute its own z-score.

## Absorption Logic

After a cascade, the analyzer tracks observations inside `ABSORPTION_WINDOW_MS`.

```text
priceHeld = abs(price - cascade_extreme) <= cascade_extreme * ABSORPTION_PRICE_BAND_BPS / 10000
```

Absorption is confirmed when price has held for `ABSORPTION_MIN_HOLD_SECONDS` and one exhaustion signal is present:

- Taker volume on the forced side trends down across recent buckets.
- Cumulative volume delta reverses away from forced flow.
- Open interest stabilizes inside the configured bps band.

## Entry Logic

The signal engine accepts one of three triggers:

- Structural reclaim: close crosses the pre-cascade swing level.
- VWAP reclaim: close crosses cascade VWAP.
- Impulsive bar: body >= `IMPULSIVE_BAR_BODY_ATR * ATR_1M` and volume >= `IMPULSIVE_BAR_VOLUME_MULT * average_volume`.

Hard gates reject entries during crisis regime, misaligned CVD, declining open interest, second-cascade cooldown, news blackout, extreme realized volatility, or loss-limit breach.

## Risk Model

Sizing selects the smallest of:

```text
risk_units = equity * RISK_PER_TRADE_PCT / abs(entry - stop)
notional_units = equity * MAX_POSITION_NOTIONAL_PCT / entry
liquidity_units = ASSET_LIQUIDITY_CAP_USD / entry
heat_units = remaining_heat_budget / risk_per_unit
```

`MAX_POSITION_NOTIONAL_PCT` and `ASSET_LIQUIDITY_CAP_USD` are legacy/global fallbacks. Production sizing uses the per-asset values inside `CASCADE_ASSET_PROFILES`, so HYPE can be enabled with a much lower liquidity cap and tighter notional cap than BTC.

The heat manager computes same-direction correlated heat and separates long and short books. A heat-cap rejection is a critical operational event because it indicates the portfolio was already at the cascade risk limit.

## Exit Logic

Default exits are:

- Partial 1 at `PARTIAL_1_R`.
- Partial 2 at `PARTIAL_2_R`.
- Runner with ATR or EMA trailing stop.
- Full stop at the cascade wick plus `STOP_BUFFER_ATR`.
- Time stop at `CASCADE_TIME_STOP_HOURS` when the trade fails to reach 1R.

The cascade taker path is disabled by default and requires live-readiness proof before any live IOC route can be enabled.
