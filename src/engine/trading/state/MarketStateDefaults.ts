import { DEFAULT_SOURCE_WEIGHT } from "../../../TradingEngineConstants";
import type { EngineState, MicrostructureMetrics, PriceDiscoveryMetrics } from "../../../types";

export function defaultMicrostructure(): MicrostructureMetrics {
  return {
    marketKey: null,
    instrumentCode: null,
    exchangeCode: null,
    source_exchange: null,
    sourceWeight: DEFAULT_SOURCE_WEIGHT,
    bestBid: null,
    bestAsk: null,
    midPrice: null,
    spread: null,
    spreadBps: null,
    bidVolume: 0,
    askVolume: 0,
    weightedImbalance: null,
    depthLevels: 0,
    lastSequence: null,
    timeToBookMs: null,
    isSynced: false,
    updatedAt: null
  };
}

export function defaultPriceDiscovery(): PriceDiscoveryMetrics {
  return {
    instrumentCode: null,
    weightedMidPrice: null,
    primaryExchange: null,
    primaryWeight: 0,
    sourceCount: 0,
    sources: [],
    updatedAt: null
  };
}

export function defaultLeadLagMetrics(): EngineState["leadLag"] {
  return {
    schemaVersion: "lead-lag.v1",
    leadInstrument: null,
    lagInstrument: null,
    correlation: null,
    lagMs: null,
    leadLagDelta: null,
    expectedValue: null,
    executable: false,
    sampleCount: 0,
    updatedAt: null
  };
}
