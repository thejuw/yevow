import type {
  EngineState,
  Env,
  GlobalRiskConfig,
  InternalOrderBook,
  Position
} from "../../../types";
import { currentMarkPriceForInstrument } from "../book/BookViews";
import { parseDeltaNormalizationWeights } from "../state/EngineStateDefaults";
import {
  calculateInventoryState,
  referencePriceForBaseAsset,
  resolveInventoryStateConfig
} from "./InventoryRuntime";

export interface TradingInventoryStateInput {
  readonly observedAt: string;
  readonly positions: Record<string, Position>;
  readonly config: GlobalRiskConfig;
  readonly env: Pick<
    Env,
    | "MAX_INVENTORY_UNITS"
    | "MAX_INVENTORY_DELTA"
    | "RISK_AVERSION_FACTOR"
    | "DELTA_NORMALIZATION_WEIGHTS"
  >;
  readonly orderBook: Map<string, InternalOrderBook>;
  readonly microstructure: EngineState["microstructure"];
}

export interface TradingInventoryStateTarget {
  readonly cachedConfig: GlobalRiskConfig;
  readonly env: TradingInventoryStateInput["env"];
  readonly orderBook: Map<string, InternalOrderBook>;
  readonly engineState: Pick<EngineState, "microstructure" | "openPositions">;
}

export function calculateTradingInventoryState(
  input: TradingInventoryStateInput
): EngineState["inventory"] {
  const inventoryConfig = resolveInventoryStateConfig({
    config: input.config,
    maxInventoryUnitsValue: input.env.MAX_INVENTORY_UNITS,
    maxInventoryDeltaValue: input.env.MAX_INVENTORY_DELTA,
    riskAversionFactorValue: input.env.RISK_AVERSION_FACTOR
  });
  const baseAsset = "BTC";

  return calculateInventoryState({
    positions: input.positions,
    observedAt: input.observedAt,
    maxInventoryUnits: inventoryConfig.maxInventoryUnits,
    maxInventoryDelta: inventoryConfig.maxInventoryDelta,
    riskAversionFactor: inventoryConfig.riskAversionFactor,
    baseAsset,
    baseReferencePrice: referencePriceForBaseAsset({
      baseAsset,
      orderBooks: input.orderBook.values(),
      positions: input.positions,
      microstructureMidPrice: input.microstructure.midPrice
    }),
    configuredWeights: parseDeltaNormalizationWeights(input.env.DELTA_NORMALIZATION_WEIGHTS),
    markPrice: (instrumentCode, fallback) =>
      currentMarkPriceForInstrument(
        {
          orderBook: input.orderBook,
          microstructure: input.microstructure
        },
        instrumentCode,
        fallback
      )
  });
}

export function calculateTradingInventoryStateForTarget(
  input: {
    readonly observedAt: string;
    readonly positions?: Record<string, Position>;
  },
  target: TradingInventoryStateTarget
): EngineState["inventory"] {
  return calculateTradingInventoryState({
    observedAt: input.observedAt,
    positions: input.positions ?? target.engineState.openPositions,
    config: target.cachedConfig,
    env: target.env,
    orderBook: target.orderBook,
    microstructure: target.engineState.microstructure
  });
}
