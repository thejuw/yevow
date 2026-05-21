import type {
  EngineState,
  GlobalRiskConfig,
  InternalOrderBook,
  InventoryState,
  JsonRecord,
  TradeIntent
} from "../../../types";
import { applyInventoryHedgeSideEffects, buildInventoryHedgeIntent } from "./InventoryRuntime";

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
