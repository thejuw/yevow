import { describe, expect, it } from "vitest";
import type { CroupierDecision } from "../../src/agents/CroupierAgent";
import type { ProfilerEvaluation } from "../../src/agents/ProfilerAgent";
import type { OracleTickResult } from "../../src/engine/trading/agents/AgentEvaluationRuntime";
import {
  applyAcceptedDecisionPipelineFlow,
  buildAcceptedDecisionPipelineLifecycle,
  buildAcceptedTickFinalizationArtifacts,
  buildAcceptedTickLifecycleArtifacts,
  buildAcceptedTickStateTransition,
  finalizeAcceptedTickFlow,
  prepareAcceptedExecutionContextFlow
} from "../../src/engine/trading/pipelines/AcceptedTickRuntime";
import type {
  AcceptedDecisionPipelineInput,
  AcceptedExecutionContext,
  AcceptedTickSideEffectsInput,
  TickDecisionContext
} from "../../src/engine/trading/pipelines/TickPipelineTypes";
import { defaultEngineState } from "../../src/engine/trading/state/EngineStateDefaults";

const OBSERVED_AT = "2026-05-18T20:00:00.000Z";

describe("AcceptedTickRuntime", () => {
  it("assembles accepted tick commit and side-effect artifacts from pipeline state", async () => {
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
    const pipelineArtifacts = buildAcceptedDecisionPipelineLifecycle(pipeline, {
      evaluateProfiler: () => ({ profilerResult, profilerLatencyMs: 2.5 }),
      evaluateOracle: () => ({ oracleResult, oracleLatencyMs: 1.5 }),
      buildDecisionContext: () => decisionContext,
      evaluateCroupier: () => ({ croupierDecision, croupierLatencyMs: 3.5 }),
      prepareExecutionContext: () => executionContext
    });
    const flowEvents: string[] = [];
    const flowArtifacts = await applyAcceptedDecisionPipelineFlow(
      pipeline,
      {
        evaluateProfiler: () => ({ profilerResult, profilerLatencyMs: 2.5 }),
        evaluateOracle: () => ({ oracleResult, oracleLatencyMs: 1.5 }),
        buildDecisionContext: () => decisionContext,
        evaluateCroupier: () => ({ croupierDecision, croupierLatencyMs: 3.5 }),
        prepareExecutionContext: () => executionContext
      },
      {
        commitAcceptedTickState(commitInput) {
          flowEvents.push(`commit:${commitInput.tick.instrumentCode}:${commitInput.observedAt}`);
        },
        finalizeAcceptedTick(sideEffectsInput) {
          flowEvents.push(
            `finalize:${sideEffectsInput.tick.instrumentCode}:${sideEffectsInput.hotPathStartedAt}`
          );
          return Promise.resolve();
        }
      }
    );

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
    expect(pipelineArtifacts).toEqual(artifacts);
    expect(flowArtifacts).toEqual(artifacts);
    expect(flowEvents).toEqual(["commit:btc-usd:2026-05-18T20:00:00.000Z", "finalize:btc-usd:123"]);
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
    expect(
      buildAcceptedTickFinalizationArtifacts({
        sideEffects: artifacts.sideEffectsInput,
        tradingEnabled: true
      })
    ).toMatchObject({
      croupierQuoteAction: {
        kind: "NONE"
      },
      shouldPublishAmVpinTelemetry: true
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

  it("prepares accepted execution context from ensemble, Pit Boss, and quote policy", () => {
    const state = defaultEngineState("accepted-execution-context-runtime");
    const profilerResult: ProfilerEvaluation = {
      processed: true,
      skippedReason: null,
      closedBuckets: 0,
      toxicityScore: 0.2,
      state: { toxicityState: "NORMAL" } as ProfilerEvaluation["state"],
      signal: null
    };
    const croupierDecision: CroupierDecision = {
      intent: null,
      quote: null,
      pullAllQuotes: false,
      adverseSelectionCost: 0.01,
      minEvThreshold: 0.02
    };
    const pipeline = {
      tick: { instrumentCode: "btc-usd" },
      metrics: { brainTimestamp: OBSERVED_AT },
      anomalyResult: { status: state.anomaly },
      shadowReplay: false
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
    const ensemble = {
      ...state.ensemble,
      kellyMultiplier: 0.25,
      anomalyCircuitBreaker: false,
      rationale: "unit-test ensemble"
    };
    const executionPlan = {
      intent: { intentId: "intent-1" },
      orders: []
    } as unknown as NonNullable<AcceptedExecutionContext["executionPlan"]>;
    const events: string[] = [];

    const context = prepareAcceptedExecutionContextFlow(
      {
        pipeline,
        profilerResult,
        oracleState: state.oracle,
        croupierDecision,
        decisionContext,
        currentState: state,
        pitBossEnabled: true,
        kellyFraction: 0.5
      },
      {
        calculateEnsembleState(
          intent,
          profilerState,
          oracleState,
          sentimentState,
          anomalyStatus,
          observedAt
        ) {
          events.push(
            `ensemble:${intent === null}:${profilerState.toxicityState}:${oracleState.updatedAt}:${sentimentState.updatedAt}:${anomalyStatus.status}:${observedAt}`
          );
          return ensemble;
        },
        prepareExecutionPlan(intent, observedAt, options) {
          events.push(
            `plan:${intent === null}:${observedAt}:${options.stateOverride.assetMatrix === state.assetMatrix}:${options.stateOverride.ensemble === ensemble}:${options.kellyFractionOverride}`
          );
          return executionPlan;
        },
        applyQuoteSuppression(
          instrumentCode,
          _croupierDecision,
          _profilerResult,
          executionPlans,
          observedAt,
          shadowReplay,
          anomalyCircuitBreaker,
          rationale
        ) {
          events.push(
            `quote:${instrumentCode}:${executionPlans.length}:${observedAt}:${shadowReplay}:${anomalyCircuitBreaker}:${rationale}`
          );
          return {
            executionPlans,
            assetQuoteState: state.quoteState,
            strategyQuoteDisableReason: null,
            isCascadeShield: false,
            isProfilerQuoteHalt: false
          };
        }
      }
    );

    expect(context).toEqual({
      ensemble,
      executionPlan,
      executionPlans: [executionPlan],
      quotePolicy: {
        executionPlans: [executionPlan],
        assetQuoteState: state.quoteState,
        strategyQuoteDisableReason: null,
        isCascadeShield: false,
        isProfilerQuoteHalt: false
      }
    });
    expect(events).toEqual([
      `ensemble:true:NORMAL:${state.oracle.updatedAt}:${state.sentiment.updatedAt}:${state.anomaly.status}:${OBSERVED_AT}`,
      `plan:true:${OBSERVED_AT}:true:true:0.125`,
      `quote:btc-usd:1:${OBSERVED_AT}:false:false:unit-test ensemble`
    ]);
  });

  it("finalizes accepted tick side effects in deterministic order", async () => {
    const state = defaultEngineState("accepted-finalize-runtime");
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
      state: { alertThreshold: 0.7 } as ProfilerEvaluation["state"],
      signal: null
    };
    const sideEffects = {
      tick: { instrumentCode: "btc-usd" },
      metrics: { status: "FRESH", brainTimestamp: OBSERVED_AT },
      book: { instrumentCode: "btc-usd" },
      anomalyResult: { status: state.anomaly },
      profilerResult,
      profilerLatencyMs: 4,
      croupierDecision,
      executionPlans: [],
      inventory: state.inventory,
      strategyQuoteDisableReason: null,
      isCascadeShield: false,
      isProfilerQuoteHalt: true,
      oracleBayesianTrace: null,
      hotPathStartedAt: 456,
      shadowReplay: false
    } as unknown as AcceptedTickSideEffectsInput;
    const events: string[] = [];

    const finalization = await finalizeAcceptedTickFlow(
      {
        sideEffects,
        tradingEnabled: true
      },
      {
        scheduleAcceptedTickSnapshot(input) {
          events.push(`snapshot:${input.tick.instrumentCode}`);
        },
        journalAcceptedTick(input) {
          events.push(`journal:${input.metrics.brainTimestamp}`);
        },
        handleCroupierQuoteAction(instrumentCode, action) {
          events.push(`quote:${instrumentCode}:${action.kind}`);
        },
        dispatchExecutionPlans(executionPlans, shadowReplay) {
          events.push(`plans:${executionPlans.length}:${shadowReplay}`);
        },
        dispatchInventoryHedgeIfNeeded(_book, _inventory, observedAt, shadowReplay) {
          events.push(`hedge:${observedAt}:${shadowReplay}`);
        },
        handleProfilerSignal(
          instrumentCode,
          _profilerResult,
          profilerLatencyMs,
          isProfilerQuoteHalt,
          shadowReplay,
          hasQuote
        ) {
          events.push(
            `profiler:${instrumentCode}:${profilerLatencyMs}:${isProfilerQuoteHalt}:${shadowReplay}:${hasQuote}`
          );
          return Promise.resolve();
        },
        publishTickTelemetry(tick, metrics, status, hotPathStartedAt) {
          events.push(
            `telemetry:${tick.instrumentCode}:${metrics.brainTimestamp}:${status}:${hotPathStartedAt}`
          );
        },
        publishAmVpinTelemetry(_profilerState, instrumentCode, observedAt) {
          events.push(`amvpin:${instrumentCode}:${observedAt}`);
        },
        maybeRecordAgentSnapshot(observedAt) {
          events.push(`agents:${observedAt}`);
        }
      }
    );

    expect(finalization.shouldPublishAmVpinTelemetry).toBe(true);
    expect(finalization.croupierQuoteAction.kind).toBe("NONE");
    expect(events).toEqual([
      "snapshot:btc-usd",
      `journal:${OBSERVED_AT}`,
      "quote:btc-usd:NONE",
      "plans:0:false",
      `hedge:${OBSERVED_AT}:false`,
      "profiler:btc-usd:4:true:false:false",
      `telemetry:btc-usd:${OBSERVED_AT}:FRESH:456`,
      `amvpin:btc-usd:${OBSERVED_AT}`,
      `agents:${OBSERVED_AT}`
    ]);
  });
});
