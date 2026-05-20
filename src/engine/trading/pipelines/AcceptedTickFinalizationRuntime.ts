import type { ProfilerEvaluation } from "../../../agents/ProfilerAgent";
import { buildCroupierQuoteAction, type CroupierQuoteAction } from "../quotes/QuoteDispatchRuntime";
import type { AcceptedTickSideEffectsInput } from "./TickPipelineTypes";

export interface AcceptedTickFinalizationInput {
  readonly sideEffects: AcceptedTickSideEffectsInput;
  readonly tradingEnabled: boolean;
}

export interface AcceptedTickFinalizationArtifacts {
  readonly croupierQuoteAction: CroupierQuoteAction;
  readonly shouldPublishAmVpinTelemetry: boolean;
}

export interface AcceptedTickFinalizationFlowHandlers {
  readonly scheduleAcceptedTickSnapshot: (input: AcceptedTickSideEffectsInput) => void;
  readonly journalAcceptedTick: (input: AcceptedTickSideEffectsInput) => void;
  readonly handleCroupierQuoteAction: (instrumentCode: string, action: CroupierQuoteAction) => void;
  readonly dispatchExecutionPlans: (
    executionPlans: AcceptedTickSideEffectsInput["executionPlans"],
    shadowReplay: boolean
  ) => void;
  readonly dispatchInventoryHedgeIfNeeded: (
    book: AcceptedTickSideEffectsInput["book"],
    inventory: AcceptedTickSideEffectsInput["inventory"],
    observedAt: string,
    shadowReplay: boolean
  ) => void;
  readonly handleProfilerSignal: (
    instrumentCode: string,
    profilerResult: ProfilerEvaluation,
    profilerLatencyMs: number,
    isProfilerQuoteHalt: boolean,
    shadowReplay: boolean,
    hasQuote: boolean
  ) => Promise<void>;
  readonly publishTickTelemetry: (
    tick: AcceptedTickSideEffectsInput["tick"],
    metrics: AcceptedTickSideEffectsInput["metrics"],
    status: AcceptedTickSideEffectsInput["metrics"]["status"],
    hotPathStartedAt: number
  ) => void;
  readonly publishAmVpinTelemetry: (
    profilerState: ProfilerEvaluation["state"],
    instrumentCode: string,
    observedAt: string
  ) => void;
  readonly maybeRecordAgentSnapshot: (observedAt: string) => void;
}

export function buildAcceptedTickFinalizationArtifacts(
  input: AcceptedTickFinalizationInput
): AcceptedTickFinalizationArtifacts {
  const sideEffects = input.sideEffects;

  return {
    croupierQuoteAction: buildCroupierQuoteAction({
      instrumentCode: sideEffects.tick.instrumentCode,
      pullAllQuotes: sideEffects.croupierDecision.pullAllQuotes,
      quote: sideEffects.croupierDecision.quote,
      strategyQuoteDisableReason: sideEffects.strategyQuoteDisableReason,
      adverseSelectionCost: sideEffects.croupierDecision.adverseSelectionCost,
      minEvThreshold: sideEffects.croupierDecision.minEvThreshold,
      shadowReplay: sideEffects.shadowReplay,
      tradingEnabled: input.tradingEnabled,
      profilerQuoteHalt: sideEffects.isProfilerQuoteHalt,
      cascadeShield: sideEffects.isCascadeShield
    }),
    shouldPublishAmVpinTelemetry: sideEffects.profilerResult.closedBuckets > 0
  };
}

export async function finalizeAcceptedTickFlow(
  input: AcceptedTickFinalizationInput,
  handlers: AcceptedTickFinalizationFlowHandlers
): Promise<AcceptedTickFinalizationArtifacts> {
  const sideEffects = input.sideEffects;

  handlers.scheduleAcceptedTickSnapshot(sideEffects);
  handlers.journalAcceptedTick(sideEffects);

  const finalization = buildAcceptedTickFinalizationArtifacts(input);

  handlers.handleCroupierQuoteAction(
    sideEffects.tick.instrumentCode,
    finalization.croupierQuoteAction
  );
  handlers.dispatchExecutionPlans(sideEffects.executionPlans, sideEffects.shadowReplay);
  handlers.dispatchInventoryHedgeIfNeeded(
    sideEffects.book,
    sideEffects.inventory,
    sideEffects.metrics.brainTimestamp,
    sideEffects.shadowReplay
  );

  await handlers.handleProfilerSignal(
    sideEffects.tick.instrumentCode,
    sideEffects.profilerResult,
    sideEffects.profilerLatencyMs,
    sideEffects.isProfilerQuoteHalt,
    sideEffects.shadowReplay,
    Boolean(sideEffects.croupierDecision.quote)
  );

  handlers.publishTickTelemetry(
    sideEffects.tick,
    sideEffects.metrics,
    sideEffects.metrics.status,
    sideEffects.hotPathStartedAt
  );
  if (finalization.shouldPublishAmVpinTelemetry) {
    handlers.publishAmVpinTelemetry(
      sideEffects.profilerResult.state,
      sideEffects.tick.instrumentCode,
      sideEffects.metrics.brainTimestamp
    );
  }
  handlers.maybeRecordAgentSnapshot(sideEffects.metrics.brainTimestamp);

  return finalization;
}
