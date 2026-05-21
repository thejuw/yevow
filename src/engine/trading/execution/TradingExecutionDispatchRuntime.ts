import { isInventoryHedgeIntent } from "../../../execution/RiskGuards";
import type { GlobalRiskConfig, JsonRecord, MacroBias, TradeIntent } from "../../../types";
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
