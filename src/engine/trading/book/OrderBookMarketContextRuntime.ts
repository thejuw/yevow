import type { OrderBookDelta, OrderBookSnapshot } from "../../../types";

export interface OrderBookMarketContextConfig {
  resolveTickSize(instrumentCode: string, override?: number): number;
  normalizeSourceExchange(value: string | null | undefined): string;
  normalizeMarketKey(value: string): string;
  buildMarketKey(sourceExchange: string, instrumentCode: string): string;
  normalizeSourceWeight(value: unknown): number;
}

export interface OrderBookMarketContext {
  readonly instrumentCode: string;
  readonly exchangeCode: string;
  readonly sourceExchange: string;
  readonly marketKey: string;
  readonly sourceWeight: number;
  readonly tickSize: number;
}

export function resolveSnapshotBookMarketContext(
  snapshot: OrderBookSnapshot,
  config: OrderBookMarketContextConfig
): OrderBookMarketContext {
  return resolveBookMarketContext(
    {
      instrumentCode: snapshot.instrumentCode,
      exchangeCode: snapshot.exchangeCode,
      source_exchange: snapshot.source_exchange,
      marketKey: snapshot.marketKey,
      sourceWeight: snapshot.sourceWeight,
      tickSize: snapshot.tickSize
    },
    config
  );
}

export function resolveDeltaBookMarketContext(
  delta: OrderBookDelta,
  config: OrderBookMarketContextConfig
): OrderBookMarketContext {
  return resolveBookMarketContext(
    {
      instrumentCode: delta.instrumentCode,
      exchangeCode: delta.exchangeCode,
      source_exchange: delta.source_exchange,
      marketKey: delta.marketKey,
      sourceWeight: delta.sourceWeight,
      tickSize: delta.tickSize
    },
    config
  );
}

function resolveBookMarketContext(
  input: {
    readonly instrumentCode: string;
    readonly exchangeCode: string;
    readonly source_exchange?: string;
    readonly marketKey?: string;
    readonly sourceWeight?: unknown;
    readonly tickSize?: number;
  },
  config: OrderBookMarketContextConfig
): OrderBookMarketContext {
  const instrumentCode = input.instrumentCode.toLowerCase();
  const exchangeCode = input.exchangeCode.toLowerCase();
  const sourceExchange = config.normalizeSourceExchange(input.source_exchange ?? exchangeCode);

  return {
    instrumentCode,
    exchangeCode,
    sourceExchange,
    marketKey: config.normalizeMarketKey(
      input.marketKey ?? config.buildMarketKey(sourceExchange, instrumentCode)
    ),
    sourceWeight: config.normalizeSourceWeight(input.sourceWeight),
    tickSize: config.resolveTickSize(instrumentCode, input.tickSize)
  };
}
