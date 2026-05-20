import { describe, expect, it } from "vitest";
import type { CroupierDecision } from "../../src/agents/CroupierAgent";
import type { ProfilerEvaluation } from "../../src/agents/ProfilerAgent";
import type { OracleTickResult } from "../../src/engine/trading/agents/AgentEvaluationRuntime";
import {
  buildAcceptedTickLifecycleArtifacts,
  buildAcceptedTickStateTransition
} from "../../src/engine/trading/pipelines/AcceptedTickRuntime";
import type {
  AcceptedDecisionPipelineInput,
  AcceptedExecutionContext,
  TickDecisionContext
} from "../../src/engine/trading/pipelines/TickPipelineTypes";
import { defaultEngineState } from "../../src/engine/trading/state/EngineStateDefaults";

const OBSERVED_AT = "2026-05-18T20:00:00.000Z";

describe("AcceptedTickRuntime", () => {
  it("assembles accepted tick commit and side-effect artifacts from pipeline state", () => {
    const state = defaultEngineState("accepted-runtime");
    const profilerState = { alertThreshold: 0.7 } as ProfilerEvaluation["state"];
    const croupierDecision: CroupierDecision = {
      intent: null,
      quote: null,
      pullAllQuotes: false,
      adverseSelectionCost: 0.01,
      minEvThreshold: 0.02
    };
    const profilerResult: ProfilerEvaluation = {
      processed: true,
      skippedReason: null,
      closedBuckets: 1,
      toxicityScore: 0.42,
      state: profilerState,
      signal: null
    };
    const oracleResult: OracleTickResult = {
      state: state.oracle,
      bayesianTrace: {
        priorBullishProbability: 0.5,
        posteriorBullishProbability: 0.55,
        delta: 0.05,
        evidence: { reason: "unit-test" },
        updatedAt: OBSERVED_AT
      },
      regimeChanged: false
    };
    const pipeline = {
      tick: { instrumentCode: "btc-usd" },
      book: { instrumentCode: "btc-usd" },
      domSnapshot: { instrumentCode: "btc-usd" },
      volatilitySnapshot: null,
      shadowQueueState: state.shadowQueue,
      anomalyResult: { status: state.anomaly },
      metrics: { brainTimestamp: OBSERVED_AT },
      wakeUpTimeMs: null,
      orderBookUpdateMs: 3,
      hotPathStartedAt: 123,
      shadowReplay: true
    } as unknown as AcceptedDecisionPipelineInput;
    const decisionContext = {
      leadLag: state.leadLag,
      inventory: state.inventory,
      riskMetrics: state.riskMetrics,
      profilerStates: state.profilerStates,
      assetMatrix: state.assetMatrix,
      inventoryGuard: state.inventoryGuard,
      sentimentForDecision: state.sentiment
    } satisfies TickDecisionContext;
    const executionContext = {
      ensemble: state.ensemble,
      executionPlan: null,
      executionPlans: [],
      quotePolicy: {
        executionPlans: [],
        assetQuoteState: state.quoteState,
        strategyQuoteDisableReason: "MARKET_MAKING_OFF",
        isCascadeShield: false,
        isProfilerQuoteHalt: true
      }
    } satisfies AcceptedExecutionContext;

    const artifacts = buildAcceptedTickLifecycleArtifacts({
      pipeline,
      profilerResult,
      profilerLatencyMs: 2.5,
      oracleResult,
      oracleLatencyMs: 1.5,
      croupierDecision,
      croupierLatencyMs: 3.5,
      decisionContext,
      executionContext
    });

    expect(artifacts.commitInput).toMatchObject({
      tick: pipeline.tick,
      book: pipeline.book,
      oracle: state.oracle,
      sentiment: state.sentiment,
      ensemble: state.ensemble,
      assetQuoteState: state.quoteState,
      croupierDecision,
      oracleLatencyMs: 1.5,
      profilerLatencyMs: 2.5,
      croupierLatencyMs: 3.5,
      shadowReplay: true,
      observedAt: OBSERVED_AT
    });
    expect(artifacts.sideEffectsInput).toMatchObject({
      tick: pipeline.tick,
      metrics: pipeline.metrics,
      book: pipeline.book,
      profilerResult,
      croupierDecision,
      strategyQuoteDisableReason: "MARKET_MAKING_OFF",
      isProfilerQuoteHalt: true,
      oracleBayesianTrace: oracleResult.bayesianTrace,
      hotPathStartedAt: 123,
      shadowReplay: true
    });

    const transition = buildAcceptedTickStateTransition({
      currentState: state,
      config: state.cachedConfig,
      commit: artifacts.commitInput,
      internalOrderBookDepth: 8,
      maxLatencyMs: 150,
      calculateAssetMatrix: (
        observedAt,
        latestInstrumentCode,
        latestOracle,
        profilerStates,
        assetQuoteStates
      ) => {
        expect(observedAt).toBe(OBSERVED_AT);
        expect(latestInstrumentCode).toBe("btc-usd");
        expect(latestOracle).toBe(state.oracle);
        expect(profilerStates).toBe(state.profilerStates);
        expect(assetQuoteStates["btc-usd"]).toBe(state.quoteState);
        return state.assetMatrix;
      }
    });

    expect(transition).toMatchObject({
      currentState: state,
      tradingEnabled: state.cachedConfig.TRADING_ENABLED,
      shadowReplay: true,
      latencyStatus: artifacts.commitInput.metrics.status,
      internalOrderBookDepth: 8,
      quoteState: {
        status: "ACTIVE",
        reason: "PARTIAL_ASSET_SUSPENSION",
        updatedAt: OBSERVED_AT
      },
      assetQuoteStates: {
        "btc-usd": state.quoteState
      },
      shadowQueue: state.shadowQueue,
      lastTradeIntent: null,
      ordersToTrack: [],
      shouldTrackOrders: false,
      assetMatrix: state.assetMatrix,
      profilerStates: state.profilerStates,
      toxicityScore: 0.42,
      maxLatencyMs: 150,
      observedAt: OBSERVED_AT
    });
    expect(transition.agentHealth.PROFILER.latencyMs).toBe(2.5);
    expect(transition.agentHealth.CROUPIER.latencyMs).toBe(3.5);
  });
});
