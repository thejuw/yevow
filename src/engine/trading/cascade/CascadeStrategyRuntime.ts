import type { Candle } from "../../../strategy/cascade/types";
import type { GlobalRiskConfig, MarketTick } from "../../../types";

export function shouldEvaluateCascadeStrategy(
  strategyMode: GlobalRiskConfig["STRATEGY_MODE"]
): boolean {
  return strategyMode !== "OFF" && strategyMode !== "MARKET_MAKING";
}

export function closedOneMinuteCandlesForTick(
  candles: readonly Candle[],
  tick: Pick<MarketTick, "instrumentCode">
): Candle[] {
  const instrumentCode = tick.instrumentCode.toLowerCase();

  return candles.filter(
    (candle) => candle.timeframe === "1m" && candle.instrumentCode.toLowerCase() === instrumentCode
  );
}
