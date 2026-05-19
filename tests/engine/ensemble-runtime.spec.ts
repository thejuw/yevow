import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/ConfigManager";
import { calculateEnsembleState } from "../../src/engine/trading/ensemble/EnsembleRuntime";
import type {
  AnomalyStatus,
  EngineState,
  ProfilerState,
  SentimentState,
  TradeIntent
} from "../../src/types";

const OBSERVED_AT = "2026-05-18T12:30:00.000Z";

describe("EnsembleRuntime", () => {
  it("weights enabled agents and scales Kelly by regime", () => {
    const ensemble = calculateEnsembleState({
      intent: tradeIntent({ expectedValue: 2, executionCosts: 1, adverseSelectionCost: 1 }),
      profilerState: profiler("NORMAL"),
      oracleState: oracle("REGIME_RANGE"),
      sentimentState: sentiment({ bias: "BULLISH", confidence: 0.7 }),
      anomalyStatus: anomaly(),
      config: {
        ...defaultConfig,
        ORACLE_ENABLED: true,
        PROFILER_ENABLED: true,
        CROUPIER_ENABLED: true,
        SENTIMENT_ENABLED: true
      },
      observedAt: OBSERVED_AT
    });

    expect(ensemble).toMatchObject({
      schemaVersion: "ensemble.v1",
      confidence: 0.746,
      kellyMultiplier: 0.746,
      regimeMultiplier: 1,
      anomalyCircuitBreaker: false,
      rationale: "ENSEMBLE_WEIGHTED_CONFIDENCE:0.746",
      updatedAt: OBSERVED_AT
    });
    expect(ensemble.votes.map((vote) => vote.agent)).toEqual([
      "ORACLE",
      "PROFILER",
      "CROUPIER",
      "SENTIMENT"
    ]);
  });

  it("cuts confidence on toxicity and anomaly circuit breakers", () => {
    const toxic = calculateEnsembleState({
      intent: tradeIntent(),
      profilerState: profiler("CRITICAL"),
      oracleState: oracle("REGIME_TREND"),
      sentimentState: sentiment(),
      anomalyStatus: anomaly(),
      config: {
        ...defaultConfig,
        ORACLE_ENABLED: true,
        PROFILER_ENABLED: true,
        CROUPIER_ENABLED: true,
        SENTIMENT_ENABLED: true
      },
      observedAt: OBSERVED_AT
    });

    expect(toxic).toMatchObject({
      confidence: 0,
      kellyMultiplier: 0,
      anomalyCircuitBreaker: true,
      rationale: "ANOMALY_CIRCUIT_BREAKER"
    });

    const anomalous = calculateEnsembleState({
      intent: tradeIntent(),
      profilerState: profiler("NORMAL"),
      oracleState: oracle("REGIME_TREND"),
      sentimentState: sentiment(),
      anomalyStatus: anomaly({ priceZScore: 8 }),
      config: defaultConfig,
      observedAt: OBSERVED_AT
    });

    expect(anomalous.anomalyCircuitBreaker).toBe(true);
    expect(anomalous.kellyMultiplier).toBe(0);
  });

  it("shows disabled agent votes and handles sentiment direction mismatch", () => {
    const ensemble = calculateEnsembleState({
      intent: tradeIntent({ direction: "SHORT" }),
      profilerState: profiler("CONTESTED"),
      oracleState: oracle("REGIME_CRISIS"),
      sentimentState: sentiment({ bias: "BULLISH", confidence: 0.8 }),
      anomalyStatus: anomaly(),
      config: {
        ...defaultConfig,
        ORACLE_ENABLED: false,
        PROFILER_ENABLED: true,
        CROUPIER_ENABLED: false,
        SENTIMENT_ENABLED: true
      },
      observedAt: OBSERVED_AT
    });

    expect(ensemble.regimeMultiplier).toBe(0.25);
    expect(ensemble.votes).toMatchObject([
      { agent: "ORACLE", confidence: 0, rationale: "DISABLED" },
      { agent: "PROFILER", confidence: 0.55, rationale: "CONTESTED" },
      { agent: "CROUPIER", confidence: 0, rationale: "DISABLED" },
      { agent: "SENTIMENT", confidence: 0.2, rationale: "LEXICAL:BULLISH" }
    ]);
    expect(ensemble.confidence).toBe(0.195);
    expect(ensemble.kellyMultiplier).toBe(0.04875);
  });
});

function profiler(toxicityState: ProfilerState["toxicityState"]): ProfilerState {
  return { toxicityState } as ProfilerState;
}

function oracle(regime: EngineState["oracle"]["regime"]): EngineState["oracle"] {
  return { regime, volatility: 0.02 } as EngineState["oracle"];
}

function sentiment(overrides: Partial<SentimentState> = {}): SentimentState {
  return {
    bias: "NEUTRAL",
    confidence: 0.5,
    provider: "LEXICAL",
    ...overrides
  } as SentimentState;
}

function anomaly(overrides: Partial<AnomalyStatus> = {}): AnomalyStatus {
  return {
    status: "CLEAR",
    priceZScore: null,
    volumeZScore: null,
    cancellationToExecutionRatio: 0,
    cancellationCount: 0,
    executionCount: 0,
    lastAnomaly: null,
    updatedAt: null,
    ...overrides
  };
}

function tradeIntent(overrides: Partial<TradeIntent> = {}): TradeIntent {
  return {
    schemaVersion: "trade-intent.v1",
    intentId: "intent-1",
    traceId: "trace-1",
    instrumentCode: "btc-usd",
    marketKey: "hyperliquid:btc-usd",
    source_exchange: "hyperliquid",
    direction: "LONG",
    action: "BUY",
    orderType: "LIMIT",
    postOnly: true,
    timeInForce: "ALO",
    intendedPrice: 100,
    expectedPrice: 100,
    requestedSize: 1,
    approvedSize: 1,
    probabilityWin: 0.55,
    probabilityLoss: 0.45,
    profit: 2,
    loss: 1,
    executionCosts: 1,
    adverseSelectionCost: 1,
    expectedValue: 1,
    minEvThreshold: 0,
    maxSlippageBps: 1,
    confidence: 0.6,
    rationale: "test",
    createdAt: OBSERVED_AT,
    ...overrides
  };
}
