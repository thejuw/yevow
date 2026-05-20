import type { MarketTick } from "../../../types";
import type { TickIngestResult } from "../TradingEngineRouteTypes";
import { normalizeNativeInstrumentCode } from "../helpers/NativeHyperliquidRuntime";
import { isTargetInstrument } from "./AssetStateRuntime";

export interface TickTargetPreflightResult {
  readonly normalizedInstrument: string;
  readonly rejection: TickIngestResult | null;
}

export function evaluateTickTargetPreflight(input: {
  readonly tick: MarketTick;
  readonly shadowReplay: boolean;
}): TickTargetPreflightResult {
  const normalizedInstrument = normalizeNativeInstrumentCode(input.tick.instrumentCode);

  if (!input.shadowReplay && !isTargetInstrument(normalizedInstrument)) {
    return {
      normalizedInstrument,
      rejection: {
        accepted: false,
        status: "IGNORED",
        reason: "NON_TARGET_ASSET",
        processedCount: 0
      }
    };
  }

  return { normalizedInstrument, rejection: null };
}
