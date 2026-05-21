import { isInventoryHedgeIntent } from "../../../execution/RiskGuards";
import { RATE_LIMIT_STATE_KEY } from "../../../TradingEngineConstants";
import type { Env, GlobalRiskConfig, JsonRecord, MacroBias, TradeIntent } from "../../../types";
import type { RateLimitPriority } from "../../../utils/RateLimiter";
import {
  isInstrumentSelectedByMoltworker,
  selectedMoltworkerInstruments
} from "../state/AssetSelectionRuntime";
import {
  dispatchTradeIntentSideEffects,
  dispatchTradeIntentToExecutioner
} from "./TradeIntentDispatchRuntime";
import type {
  ExecutionDispatchFetcher,
  TradeIntentDispatchReservation
} from "./TradeIntentDispatchRuntime";
import { wait } from "../helpers/RuntimeMath";

export interface TradingExecutionDispatchLogger {
  info(eventType: string, message: string, telemetry?: JsonRecord): void;
  warn(eventType: string, message: string, telemetry?: JsonRecord): void;
  error(eventType: string, message: string, telemetry?: JsonRecord): void;
}

export interface TradingExecutionDispatchInput {
  readonly intent: TradeIntent;
  readonly initialDelayMs: number;
  readonly executioner: ExecutionDispatchFetcher | undefined;
  readonly cachedConfig: Pick<GlobalRiskConfig, "TRADING_ENABLED" | "HEDGE_ENABLED">;
  readonly macroBias: MacroBias;
  readonly logger: TradingExecutionDispatchLogger;
}

export interface TradingExecutionDispatchHandlers {
  readonly reservePaperExecutionBudget: (intent: TradeIntent) => boolean;
  readonly wait: (ms: number) => Promise<void>;
  readonly reserveExecutionCapacity: (
    exchangeKey: string,
    priority: RateLimitPriority
  ) => TradeIntentDispatchReservation;
  readonly persistRateLimitState: () => void;
  readonly enqueueExecutionIntent: (
    intent: TradeIntent,
    priority: RateLimitPriority,
    waitMs: number
  ) => Promise<void>;
}

export interface TradingExecutionDispatchTarget {
  readonly env: Pick<Env, "EXECUTIONER">;
  readonly cachedConfig: Pick<GlobalRiskConfig, "TRADING_ENABLED" | "HEDGE_ENABLED">;
  readonly macroBias: MacroBias;
  readonly logger: TradingExecutionDispatchLogger;
  readonly rateLimiter: {
    reserve(exchangeKey: string, priority: RateLimitPriority): TradeIntentDispatchReservation;
    exportState(): unknown;
  };
  reservePaperExecutionBudget(intent: TradeIntent): boolean;
  waitUntilStoragePut(key: string, value: unknown, reason: string): void;
  enqueueExecutionIntent(
    intent: TradeIntent,
    priority: RateLimitPriority,
    waitMs: number
  ): Promise<void>;
}

export async function dispatchTradingExecutionIntent(
  input: TradingExecutionDispatchInput,
  handlers: TradingExecutionDispatchHandlers
): Promise<void> {
  const inventoryHedge = isInventoryHedgeIntent(input.intent);
  const executioner = input.executioner;

  await dispatchTradeIntentSideEffects(
    {
      intent: input.intent,
      hasExecutioner: Boolean(executioner),
      tradingEnabled: input.cachedConfig.TRADING_ENABLED,
      hedgeEnabled: input.cachedConfig.HEDGE_ENABLED,
      inventoryHedge,
      instrumentSelected: isInstrumentSelectedByMoltworker(
        input.intent.instrumentCode,
        input.macroBias
      ),
      selectedInstruments: [...selectedMoltworkerInstruments(input.macroBias)],
      initialDelayMs: input.initialDelayMs
    },
    {
      logger: input.logger,
      reservePaperExecutionBudget: handlers.reservePaperExecutionBudget,
      wait: handlers.wait,
      reserveExecutionCapacity: handlers.reserveExecutionCapacity,
      persistRateLimitState: handlers.persistRateLimitState,
      enqueueExecutionIntent: handlers.enqueueExecutionIntent,
      dispatchTradeIntent: (tradeIntent) => {
        if (!executioner) {
          return Promise.resolve();
        }
        return dispatchTradeIntentToExecutioner({
          executioner,
          logger: input.logger,
          intent: tradeIntent
        });
      }
    }
  );
}

export function dispatchTradingExecutionIntentForTarget(
  intent: TradeIntent,
  initialDelayMs: number,
  target: TradingExecutionDispatchTarget
): Promise<void> {
  return dispatchTradingExecutionIntent(
    {
      intent,
      initialDelayMs,
      executioner: target.env.EXECUTIONER,
      cachedConfig: target.cachedConfig,
      macroBias: target.macroBias,
      logger: target.logger
    },
    {
      reservePaperExecutionBudget: (tradeIntent) => target.reservePaperExecutionBudget(tradeIntent),
      wait,
      reserveExecutionCapacity: (exchangeKey, priority) =>
        target.rateLimiter.reserve(exchangeKey, priority),
      persistRateLimitState: () => {
        target.waitUntilStoragePut(
          RATE_LIMIT_STATE_KEY,
          target.rateLimiter.exportState(),
          "EXECUTION_RATE_LIMIT"
        );
      },
      enqueueExecutionIntent: (tradeIntent, priority, waitMs) =>
        target.enqueueExecutionIntent(tradeIntent, priority, waitMs)
    }
  );
}
