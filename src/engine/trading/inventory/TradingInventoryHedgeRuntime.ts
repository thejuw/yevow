import type {
  EngineState,
  GlobalRiskConfig,
  InternalOrderBook,
  InventoryState,
  JsonRecord,
  TradeIntent
} from "../../../types";
import { applyInventoryHedgeSideEffects, buildInventoryHedgeIntent } from "./InventoryRuntime";
import {
  dispatchTradingExecutionIntentForTarget,
  type TradingExecutionDispatchTarget
} from "../execution/TradingExecutionDispatchRuntime";

export interface TradingInventoryHedgeInput {
  readonly book: InternalOrderBook;
  readonly inventory: InventoryState;
  readonly observedAt: string;
  readonly shadowReplay: boolean;
  readonly engineId: EngineState["engineId"];
  readonly config: GlobalRiskConfig;
  readonly lastHedgeAtMs: number;
  readonly fallbackNowMs: number;
}

export interface TradingInventoryHedgeHandlers {
  readonly rememberDispatchedAt: (instrumentCode: string, dispatchedAtMs: number) => void;
  readonly logAuthorized: (metadata: JsonRecord) => void;
  readonly scheduleExecution: (intent: TradeIntent) => void;
}

export interface TradingInventoryHedgeTarget {
  readonly engineState: Pick<EngineState, "engineId">;
  readonly cachedConfig: GlobalRiskConfig;
  readonly lastHedgeDispatchedAt: Map<string, number>;
  readonly logger: {
    warn(eventType: string, message: string, telemetry?: JsonRecord): void;
  };
  readonly state: {
    waitUntil(work: Promise<void>): void;
  };
  dispatchExecution?(intent: TradeIntent): Promise<void>;
}

export function dispatchTradingInventoryHedgeIfNeeded(
  input: TradingInventoryHedgeInput,
  handlers: TradingInventoryHedgeHandlers
): void {
  const hedge = buildInventoryHedgeIntent({
    book: input.book,
    inventory: input.inventory,
    observedAt: input.observedAt,
    engineId: input.engineId,
    config: input.config,
    lastHedgeAtMs: input.lastHedgeAtMs,
    fallbackNowMs: input.fallbackNowMs
  });

  applyInventoryHedgeSideEffects(
    {
      hedge,
      inventory: input.inventory,
      triggerPct: input.config.HEDGE_TRIGGER_INVENTORY_PCT,
      suppressExecution: input.shadowReplay
    },
    handlers
  );
}

export function dispatchTradingEngineInventoryHedgeIfNeeded(
  book: InternalOrderBook,
  inventory: InventoryState,
  observedAt: string,
  shadowReplay: boolean,
  target: TradingInventoryHedgeTarget
): void {
  dispatchTradingInventoryHedgeIfNeeded(
    {
      book,
      inventory,
      observedAt,
      shadowReplay,
      engineId: target.engineState.engineId,
      config: target.cachedConfig,
      lastHedgeAtMs: target.lastHedgeDispatchedAt.get(book.instrumentCode) ?? 0,
      fallbackNowMs: Date.now()
    },
    {
      rememberDispatchedAt: (instrumentCode, dispatchedAtMs) => {
        target.lastHedgeDispatchedAt.set(instrumentCode, dispatchedAtMs);
      },
      logAuthorized: (metadata) => {
        target.logger.warn(
          "INVENTORY_HEDGE_AUTHORIZED",
          "Inventory hedge IOC path authorized",
          metadata
        );
      },
      scheduleExecution: (intent) => {
        target.state.waitUntil(
          target.dispatchExecution
            ? target.dispatchExecution(intent)
            : dispatchTradingExecutionIntentForTarget(
                intent,
                0,
                target as unknown as TradingExecutionDispatchTarget
              )
        );
      }
    }
  );
}
