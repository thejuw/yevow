import { evaluateIntentDispatchGate } from "../../IntentGeneration";
import type { EngineState, GlobalRiskConfig, JsonRecord, TradeIntent } from "../../../types";

export interface ExecutionPlanDispatchLogInput {
  readonly intent: TradeIntent;
  readonly sorSavings: number;
  readonly intendedSize: number;
  readonly camouflagedSize: number;
  readonly icebergChildCount: number;
  readonly timingJitterMs: number;
}

export interface ExecutionPlanDispatchBlockedLogInput {
  readonly intent: TradeIntent;
  readonly reason: string | null;
}

export interface ExecutionPlanDispatchRuntimePlan {
  readonly intent: TradeIntent;
  readonly sorPlan: {
    readonly sorSavings: number;
  };
  readonly camouflage: {
    readonly intendedSize: number;
    readonly camouflagedSize: number;
    readonly icebergChunks: readonly TradeIntent[];
    readonly timingJitterMs: number;
  };
}

export interface ExecutionPlanDispatchActionInput {
  readonly plan: ExecutionPlanDispatchRuntimePlan;
  readonly dispatchGate: {
    readonly allowed: boolean;
    readonly reason: string | null;
  };
  readonly shadowReplay: boolean;
  readonly tradingEnabled: boolean;
}

export interface ExecutionPlanDispatchLogger {
  info(eventType: string, message: string, telemetry?: JsonRecord): void;
  warn(eventType: string, message: string, telemetry?: JsonRecord): void;
}

export interface ExecutionPlanDispatchSideEffectHandlers {
  readonly logger: ExecutionPlanDispatchLogger;
  readonly schedule: (work: Promise<void>) => void;
  readonly dispatchExecution: (intent: TradeIntent, timingJitterMs: number) => Promise<void>;
}

export interface TradingExecutionPlanDispatchTarget {
  readonly engineState: Pick<EngineState, "mode" | "cachedConfig" | "citadel" | "quoteState">;
  readonly cachedConfig: Pick<GlobalRiskConfig, "TRADING_ENABLED">;
  readonly logger: ExecutionPlanDispatchLogger;
  readonly state: {
    waitUntil(work: Promise<void>): void;
  };
  dispatchExecution(intent: TradeIntent, timingJitterMs: number): Promise<void>;
}

export interface ExecutionPlanSideEffectsInput {
  readonly executionPlans: readonly ExecutionPlanDispatchRuntimePlan[];
  readonly riskState: Pick<EngineState, "mode" | "cachedConfig" | "citadel" | "quoteState">;
  readonly shadowReplay: boolean;
  readonly tradingEnabled: boolean;
  readonly handlers: ExecutionPlanDispatchSideEffectHandlers;
}

export type ExecutionPlanDispatchAction =
  | {
      readonly kind: "AUTHORIZED";
      readonly metadata: JsonRecord;
      readonly childIntents: readonly TradeIntent[];
      readonly timingJitterMs: number;
    }
  | {
      readonly kind: "BLOCKED";
      readonly metadata: JsonRecord;
    }
  | {
      readonly kind: "SHADOW";
      readonly metadata: JsonRecord;
    }
  | {
      readonly kind: "NONE";
    };

export function tradeIntentAuthorizedLogMetadata(input: ExecutionPlanDispatchLogInput): JsonRecord {
  return {
    intentId: input.intent.intentId,
    instrumentCode: input.intent.instrumentCode,
    expectedValue: input.intent.expectedValue,
    approvedSize: input.intent.approvedSize,
    sorSavings: input.sorSavings,
    intendedSize: input.intendedSize,
    camouflagedSize: input.camouflagedSize,
    icebergChildCount: input.icebergChildCount,
    timingJitterMs: input.timingJitterMs
  };
}

export function tradeIntentDispatchBlockedLogMetadata(
  input: ExecutionPlanDispatchBlockedLogInput
): JsonRecord {
  return {
    intentId: input.intent.intentId,
    instrumentCode: input.intent.instrumentCode,
    reason: input.reason
  };
}

export function shadowTradeIntentAuthorizedLogMetadata(
  input: Pick<ExecutionPlanDispatchLogInput, "intent" | "icebergChildCount">
): JsonRecord {
  return {
    intentId: input.intent.intentId,
    instrumentCode: input.intent.instrumentCode,
    expectedValue: input.intent.expectedValue,
    approvedSize: input.intent.approvedSize,
    icebergChildCount: input.icebergChildCount
  };
}

export function buildExecutionPlanDispatchAction(
  input: ExecutionPlanDispatchActionInput
): ExecutionPlanDispatchAction {
  if (!input.shadowReplay && input.dispatchGate.allowed) {
    return {
      kind: "AUTHORIZED",
      metadata: tradeIntentAuthorizedLogMetadata({
        intent: input.plan.intent,
        sorSavings: input.plan.sorPlan.sorSavings,
        intendedSize: input.plan.camouflage.intendedSize,
        camouflagedSize: input.plan.camouflage.camouflagedSize,
        icebergChildCount: input.plan.camouflage.icebergChunks.length,
        timingJitterMs: input.plan.camouflage.timingJitterMs
      }),
      childIntents: input.plan.camouflage.icebergChunks,
      timingJitterMs: input.plan.camouflage.timingJitterMs
    };
  }

  if (!input.shadowReplay && input.tradingEnabled) {
    return {
      kind: "BLOCKED",
      metadata: tradeIntentDispatchBlockedLogMetadata({
        intent: input.plan.intent,
        reason: input.dispatchGate.reason
      })
    };
  }

  if (input.shadowReplay) {
    return {
      kind: "SHADOW",
      metadata: shadowTradeIntentAuthorizedLogMetadata({
        intent: input.plan.intent,
        icebergChildCount: input.plan.camouflage.icebergChunks.length
      })
    };
  }

  return { kind: "NONE" };
}

export function dispatchExecutionPlanSideEffects(input: ExecutionPlanSideEffectsInput): void {
  for (const plan of input.executionPlans) {
    const dispatchGate = evaluateIntentDispatchGate(input.riskState, plan.intent);
    const dispatchAction = buildExecutionPlanDispatchAction({
      plan,
      dispatchGate,
      shadowReplay: input.shadowReplay,
      tradingEnabled: input.tradingEnabled
    });

    if (dispatchAction.kind === "AUTHORIZED") {
      input.handlers.logger.info(
        "TRADE_INTENT_AUTHORIZED",
        "PitBoss authorized executable intent",
        dispatchAction.metadata
      );
      for (const childIntent of dispatchAction.childIntents) {
        input.handlers.schedule(
          input.handlers.dispatchExecution(childIntent, dispatchAction.timingJitterMs)
        );
      }
      continue;
    }

    if (dispatchAction.kind === "BLOCKED") {
      input.handlers.logger.warn(
        "TRADE_INTENT_DISPATCH_BLOCKED",
        "Intent dispatch gate blocked execution",
        dispatchAction.metadata
      );
      continue;
    }

    if (dispatchAction.kind === "SHADOW") {
      input.handlers.logger.info(
        "SHADOW_TRADE_INTENT_AUTHORIZED",
        "Replay generated shadow trade intent",
        dispatchAction.metadata
      );
    }
  }
}

export function dispatchTradingExecutionPlans(
  executionPlans: readonly ExecutionPlanDispatchRuntimePlan[],
  shadowReplay: boolean,
  target: TradingExecutionPlanDispatchTarget
): void {
  dispatchExecutionPlanSideEffects({
    executionPlans,
    riskState: target.engineState,
    shadowReplay,
    tradingEnabled: target.cachedConfig.TRADING_ENABLED,
    handlers: {
      logger: target.logger,
      schedule: (work) => {
        target.state.waitUntil(work);
      },
      dispatchExecution: (intent, timingJitterMs) =>
        target.dispatchExecution(intent, timingJitterMs)
    }
  });
}
