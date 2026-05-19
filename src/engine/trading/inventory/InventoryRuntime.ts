import type { InventoryState, Position } from "../../../types";
import { roundCrypto, roundMetric } from "../book/SortedBookSide";

export interface InventoryStateInput {
  readonly positions: Record<string, Position>;
  readonly observedAt: string;
  readonly maxInventoryUnits: number;
  readonly maxInventoryDelta: number;
  readonly riskAversionFactor: number;
  readonly baseAsset: string;
  readonly baseReferencePrice: number;
  readonly configuredWeights: Record<string, number>;
  readonly markPrice: (instrumentCode: string, fallback: number) => number;
}

export function calculateInventoryState(input: InventoryStateInput): InventoryState {
  const normalized = normalizeInventoryDelta(input);
  const netDelta = Object.values(input.positions).reduce(
    (sum, position) => sum + (position.side === "LONG" ? position.quantity : -position.quantity),
    0
  );
  const inventoryPenalty = Math.abs(normalized.current_inventory_delta) * input.riskAversionFactor;
  const stopBid =
    netDelta >= input.maxInventoryUnits ||
    (input.maxInventoryDelta > 0 && normalized.current_inventory_delta >= input.maxInventoryDelta);
  const stopAsk =
    netDelta <= -input.maxInventoryUnits ||
    (input.maxInventoryDelta > 0 && normalized.current_inventory_delta <= -input.maxInventoryDelta);

  return {
    netDelta,
    current_inventory_delta: normalized.current_inventory_delta,
    baseAsset: normalized.baseAsset,
    normalization: normalized.normalization,
    maxInventoryUnits: input.maxInventoryUnits,
    maxInventoryDelta: input.maxInventoryDelta,
    inventoryPenalty,
    stopBid,
    stopAsk,
    updatedAt: input.observedAt
  };
}

export function normalizeInventoryDelta(
  input: Pick<
    InventoryStateInput,
    "positions" | "baseAsset" | "baseReferencePrice" | "configuredWeights" | "markPrice"
  >
): Pick<InventoryState, "current_inventory_delta" | "baseAsset" | "normalization"> {
  const normalization: Record<string, number> = {};
  let currentInventoryDelta = 0;

  for (const position of Object.values(input.positions)) {
    const signedQuantity = position.side === "LONG" ? position.quantity : -position.quantity;
    const instrumentCode = position.instrumentCode.toLowerCase();
    const markPrice = input.markPrice(instrumentCode, position.markPrice);
    const configuredWeight = input.configuredWeights[instrumentCode];
    const inferredWeight =
      input.baseReferencePrice > 0 && markPrice > 0 ? markPrice / input.baseReferencePrice : 1;
    const weight =
      typeof configuredWeight === "number" && Number.isFinite(configuredWeight)
        ? configuredWeight
        : inferredWeight;

    normalization[instrumentCode] = roundMetric(weight, 8);
    currentInventoryDelta += signedQuantity * weight;
  }

  return {
    current_inventory_delta: roundCrypto(currentInventoryDelta),
    baseAsset: input.baseAsset,
    normalization
  };
}
