import { buildMarketKey, finiteNumber } from "../helpers/RuntimeHelpers";
import type { EngineState, InternalOrderBook, MarketTick } from "../../../types";

export interface FundingTickStateResult {
  readonly state: EngineState;
  readonly changed: boolean;
}

export function stateAfterFundingTick(
  currentState: EngineState,
  tick: MarketTick,
  observedAt: string
): FundingTickStateResult {
  const fundingRates = nextFundingRatesAfterTick(currentState.fundingRates, tick, observedAt);

  return {
    changed: fundingRates !== currentState.fundingRates,
    state:
      fundingRates === currentState.fundingRates
        ? currentState
        : {
            ...currentState,
            fundingRates
          }
  };
}

export function nextFundingRatesAfterTick(
  currentFundingRates: EngineState["fundingRates"],
  tick: MarketTick,
  observedAt: string
): EngineState["fundingRates"] {
  const fundingRateHourly =
    finiteNumber(tick.fundingRateHourly) ?? finiteNumber(tick.raw?.fundingRateHourly);

  if (fundingRateHourly === null) {
    return currentFundingRates;
  }

  const marketKey = buildMarketKey(tick.source_exchange, tick.instrumentCode);
  return {
    ...currentFundingRates,
    [marketKey]: {
      instrumentCode: tick.instrumentCode,
      source_exchange: tick.source_exchange,
      marketKey,
      hourlyRate: fundingRateHourly,
      markPrice: finiteNumber(tick.markPrice) ?? finiteNumber(tick.raw?.markPrice),
      oraclePrice: finiteNumber(tick.oraclePrice) ?? finiteNumber(tick.raw?.oraclePrice),
      openInterest: finiteNumber(tick.openInterest) ?? finiteNumber(tick.raw?.openInterest),
      receivedAt: tick.receivedAt,
      updatedAt: observedAt
    }
  };
}

export function currentFundingRate(
  fundingRates: EngineState["fundingRates"],
  book: InternalOrderBook
): number {
  const direct = fundingRates[book.marketKey]?.hourlyRate;
  if (typeof direct === "number" && Number.isFinite(direct)) {
    return direct;
  }

  const fallback = Object.values(fundingRates).find(
    (entry) => entry.instrumentCode === book.instrumentCode
  )?.hourlyRate;

  return typeof fallback === "number" && Number.isFinite(fallback) ? fallback : 0;
}
