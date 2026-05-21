import { DEFAULT_PAPER_MAX_GHOST_FILLS_PER_MINUTE } from "../../../TradingEngineConstants";
import { isShadowMode } from "../../../utils/CitadelProtocol";
import { readPositiveInteger } from "../helpers/RuntimeParsing";
import type { Env, JsonRecord, TradeIntent } from "../../../types";

export interface PaperExecutionBudgetState {
  readonly windowStartedAtMs: number;
  readonly windowCount: number;
  readonly windowDropped: number;
  readonly throttleLoggedAtMs: number;
}

export interface PaperExecutionBudgetInput extends PaperExecutionBudgetState {
  readonly shadowMode: boolean;
  readonly nowMs: number;
  readonly maxPerMinute: number;
  readonly windowMs?: number;
  readonly throttleLogIntervalMs?: number;
}

export interface PaperExecutionBudgetResult {
  readonly allowed: boolean;
  readonly shouldLogThrottle: boolean;
  readonly state: PaperExecutionBudgetState;
}

export interface IntentPaperExecutionBudgetInput extends PaperExecutionBudgetState {
  readonly intent: Pick<TradeIntent, "intentId" | "instrumentCode">;
  readonly shadowMode: boolean;
  readonly nowMs: number;
  readonly maxPerMinuteValue: string | undefined;
}

export interface IntentPaperExecutionBudgetResult extends PaperExecutionBudgetResult {
  readonly maxPerMinute: number;
  readonly logMetadata: JsonRecord | null;
  readonly publishPayload: JsonRecord | null;
}

export interface IntentPaperExecutionBudgetSideEffectHandlers {
  readonly applyState: (state: PaperExecutionBudgetState) => void;
  readonly warnThrottle: (metadata: JsonRecord) => void;
  readonly publishThrottle: (payload: JsonRecord) => void;
}

export interface TradingPaperExecutionBudgetTarget {
  readonly env: Pick<Env, "PAPER_MAX_GHOST_FILLS_PER_MINUTE" | "SHADOW_MODE">;
  paperExecutionWindowStartedAtMs: number;
  paperExecutionWindowCount: number;
  paperExecutionWindowDropped: number;
  paperExecutionThrottleLoggedAtMs: number;
  readonly logger: {
    warn(eventType: string, message: string, telemetry?: JsonRecord): void;
  };
  publish(type: string, payload: Record<string, unknown>, correlationId?: string): void;
}

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_THROTTLE_LOG_INTERVAL_MS = 10_000;

export function resolvePaperMaxGhostFillsPerMinute(value: string | undefined): number {
  return readPositiveInteger(value, DEFAULT_PAPER_MAX_GHOST_FILLS_PER_MINUTE, 1, 10_000);
}

export function applyPaperExecutionBudget(
  input: PaperExecutionBudgetInput
): PaperExecutionBudgetResult {
  const currentState: PaperExecutionBudgetState = {
    windowStartedAtMs: input.windowStartedAtMs,
    windowCount: input.windowCount,
    windowDropped: input.windowDropped,
    throttleLoggedAtMs: input.throttleLoggedAtMs
  };

  if (!input.shadowMode) {
    return {
      allowed: true,
      shouldLogThrottle: false,
      state: currentState
    };
  }

  const windowMs = input.windowMs ?? DEFAULT_WINDOW_MS;
  const throttleLogIntervalMs = input.throttleLogIntervalMs ?? DEFAULT_THROTTLE_LOG_INTERVAL_MS;
  let state = currentState;

  if (input.nowMs - state.windowStartedAtMs >= windowMs) {
    state = {
      ...state,
      windowStartedAtMs: input.nowMs,
      windowCount: 0,
      windowDropped: 0
    };
  }

  if (state.windowCount < input.maxPerMinute) {
    return {
      allowed: true,
      shouldLogThrottle: false,
      state: {
        ...state,
        windowCount: state.windowCount + 1
      }
    };
  }

  const nextDropped = state.windowDropped + 1;
  const shouldLogThrottle = input.nowMs - state.throttleLoggedAtMs >= throttleLogIntervalMs;

  return {
    allowed: false,
    shouldLogThrottle,
    state: {
      ...state,
      windowDropped: nextDropped,
      throttleLoggedAtMs: shouldLogThrottle ? input.nowMs : state.throttleLoggedAtMs
    }
  };
}

export function applyIntentPaperExecutionBudget(
  input: IntentPaperExecutionBudgetInput
): IntentPaperExecutionBudgetResult {
  const maxPerMinute = resolvePaperMaxGhostFillsPerMinute(input.maxPerMinuteValue);
  const budget = applyPaperExecutionBudget({
    shadowMode: input.shadowMode,
    nowMs: input.nowMs,
    maxPerMinute,
    windowStartedAtMs: input.windowStartedAtMs,
    windowCount: input.windowCount,
    windowDropped: input.windowDropped,
    throttleLoggedAtMs: input.throttleLoggedAtMs
  });

  if (!budget.shouldLogThrottle) {
    return {
      ...budget,
      maxPerMinute,
      logMetadata: null,
      publishPayload: null
    };
  }

  const windowStartedAt = new Date(budget.state.windowStartedAtMs).toISOString();

  return {
    ...budget,
    maxPerMinute,
    logMetadata: {
      intentId: input.intent.intentId,
      instrumentCode: input.intent.instrumentCode,
      maxGhostFillsPerMinute: maxPerMinute,
      windowDispatched: budget.state.windowCount,
      windowDropped: budget.state.windowDropped,
      windowStartedAt
    },
    publishPayload: {
      instrumentCode: input.intent.instrumentCode,
      maxGhostFillsPerMinute: maxPerMinute,
      windowDispatched: budget.state.windowCount,
      windowDropped: budget.state.windowDropped
    }
  };
}

export function applyIntentPaperExecutionBudgetSideEffects(
  input: IntentPaperExecutionBudgetInput,
  handlers: IntentPaperExecutionBudgetSideEffectHandlers
): IntentPaperExecutionBudgetResult {
  const budget = applyIntentPaperExecutionBudget(input);

  handlers.applyState(budget.state);

  if (budget.shouldLogThrottle) {
    handlers.warnThrottle(budget.logMetadata ?? {});
    handlers.publishThrottle(budget.publishPayload ?? {});
  }

  return budget;
}

export function reservePaperExecutionBudgetForTarget(
  intent: TradeIntent,
  target: TradingPaperExecutionBudgetTarget
): boolean {
  const budget = applyIntentPaperExecutionBudgetSideEffects(
    {
      intent,
      shadowMode: isShadowMode(target.env),
      nowMs: Date.now(),
      maxPerMinuteValue: target.env.PAPER_MAX_GHOST_FILLS_PER_MINUTE,
      windowStartedAtMs: target.paperExecutionWindowStartedAtMs,
      windowCount: target.paperExecutionWindowCount,
      windowDropped: target.paperExecutionWindowDropped,
      throttleLoggedAtMs: target.paperExecutionThrottleLoggedAtMs
    },
    {
      applyState: (state) => {
        target.paperExecutionWindowStartedAtMs = state.windowStartedAtMs;
        target.paperExecutionWindowCount = state.windowCount;
        target.paperExecutionWindowDropped = state.windowDropped;
        target.paperExecutionThrottleLoggedAtMs = state.throttleLoggedAtMs;
      },
      warnThrottle: (metadata) => {
        target.logger.warn(
          "SHADOW_PAPER_CADENCE_THROTTLED",
          "Paper execution cadence capped",
          metadata
        );
      },
      publishThrottle: (payload) => {
        target.publish("SHADOW_PAPER_CADENCE_THROTTLED", payload);
      }
    }
  );

  return budget.allowed;
}
