import { describe, expect, it } from "vitest";
import { calculateAssetMatrix } from "../../src/engine/trading/state/AssetMatrixRuntime";
import type {
  EngineState,
  InternalOrderBook,
  MacroBias,
  ProfilerState,
  QuoteState
} from "../../src/types";

const OBSERVED_AT = "2026-05-18T15:00:00.000Z";

describe("AssetMatrixRuntime", () => {
  it("allocates capital across selected synced assets by inverse volatility", () => {
    const matrix = calculateAssetMatrix({
      observedAt: OBSERVED_AT,
      latestOracle: oracle({
        instrumentCode: "btc-usd",
        volatility: 0.02,
        instrumentStates: {
          "hype-usd": oracle({ instrumentCode: "hype-usd", volatility: 0.04 })
        }
      }),
      profilerStates: {
        "btc-usd": profiler("NORMAL", 0.2, 0.1),
        "hype-usd": profiler("CONTESTED", 0.5, -0.2)
      },
      assetQuoteStates: {},
      fallbackQuoteState: quoteState(),
      macroBias: macroBias(),
      equity: 10_000,
      maxPositionPct: 0.1,
      findBestAssetBook: (instrumentCode) =>
        book(instrumentCode, instrumentCode === "btc-usd" ? 100_000 : 30),
      profilerStateForInstrument: () => profiler("NORMAL")
    });

    expect(matrix["btc-usd"]).toMatchObject({
      selectedByMoltworker: true,
      active: true,
      isSynced: true,
      capitalAllocationPct: 0.66666667,
      maxNotional: 666.66666667,
      toxicityState: "NORMAL",
      amVpin: 0.2,
      obi: 0.1
    });
    expect(matrix["hype-usd"]).toMatchObject({
      active: true,
      capitalAllocationPct: 0.33333333,
      maxNotional: 333.33333333,
      toxicityState: "CONTESTED"
    });
  });

  it("marks assets inactive when Moltworker deselects or quote suspension is active", () => {
    const matrix = calculateAssetMatrix({
      observedAt: OBSERVED_AT,
      latestOracle: oracle(),
      profilerStates: {},
      assetQuoteStates: {
        "btc-usd": quoteState({
          status: "SUSPENDED",
          reason: "ADVERSE_SELECTION_CRITICAL",
          suspendedUntil: "2026-05-18T15:00:30.000Z"
        })
      },
      fallbackQuoteState: quoteState(),
      macroBias: macroBias({ instruments: ["btc"] }),
      equity: 10_000,
      maxPositionPct: 0.1,
      findBestAssetBook: (instrumentCode) => book(instrumentCode, 100),
      profilerStateForInstrument: () => profiler("NORMAL")
    });

    expect(matrix["btc-usd"]).toMatchObject({
      selectedByMoltworker: true,
      quoteStatus: "SUSPENDED",
      quoteReason: "ADVERSE_SELECTION_CRITICAL",
      quoteEligible: false,
      active: false,
      capitalAllocationPct: 0
    });
    expect(matrix["hype-usd"]).toMatchObject({
      selectedByMoltworker: false,
      quoteEligible: false,
      active: false
    });
  });

  it("keeps critical profiler assets visible but quote-ineligible", () => {
    const matrix = calculateAssetMatrix({
      observedAt: OBSERVED_AT,
      latestOracle: oracle(),
      profilerStates: { "btc-usd": profiler("CRITICAL", 0.9, 0.8) },
      assetQuoteStates: {},
      fallbackQuoteState: quoteState(),
      macroBias: macroBias({ instruments: ["btc-usd"] }),
      equity: 1_000,
      maxPositionPct: 0.2,
      findBestAssetBook: (instrumentCode) =>
        instrumentCode === "btc-usd" ? book(instrumentCode, 100_000) : undefined,
      profilerStateForInstrument: () => profiler("NORMAL")
    });

    expect(matrix["btc-usd"]).toMatchObject({
      selectedByMoltworker: true,
      isSynced: true,
      toxicityState: "CRITICAL",
      active: false,
      quoteEligible: false,
      capitalAllocationPct: 1,
      maxNotional: 200
    });
    expect(matrix["hype-usd"].isSynced).toBe(false);
  });
});

function book(instrumentCode: string, midPrice: number): InternalOrderBook {
  return {
    schemaVersion: "internal-order-book.v1",
    marketKey: `hyperliquid:${instrumentCode}`,
    source_exchange: "hyperliquid",
    instrumentCode,
    bids: [],
    asks: [],
    bestBid: midPrice - 1,
    bestAsk: midPrice + 1,
    midPrice,
    spread: 2,
    spreadBps: 1,
    weightedImbalance: 0,
    lastSequence: 42,
    tickSize: 0.01,
    ttbLatencyMs: 1,
    isSynced: true,
    sequence: 42,
    sourceWeight: 1,
    updatedAt: OBSERVED_AT
  };
}

function quoteState(overrides: Partial<QuoteState> = {}): QuoteState {
  return {
    status: "ACTIVE",
    reason: null,
    suspendedUntil: null,
    lastQuote: null,
    updatedAt: OBSERVED_AT,
    ...overrides
  };
}

function profiler(
  toxicityState: ProfilerState["toxicityState"],
  amVpinScore = 0.1,
  obi: number | null = null
): ProfilerState {
  return { toxicityState, amVpinScore, obi } as ProfilerState;
}

function oracle(overrides: Partial<EngineState["oracle"]> = {}): EngineState["oracle"] {
  return {
    instrumentCode: "btc-usd",
    volatility: 0.02,
    instrumentStates: {},
    ...overrides
  } as EngineState["oracle"];
}

function macroBias(overrides: Partial<MacroBias> = {}): MacroBias {
  return {
    schemaVersion: "macro-bias.v1",
    direction: "NEUTRAL",
    intensity: 0,
    confidence: 0,
    instruments: [],
    reason: "unit-test",
    source: "SYSTEM",
    createdBy: "test",
    createdAt: OBSERVED_AT,
    expiresAt: null,
    ...overrides
  };
}
