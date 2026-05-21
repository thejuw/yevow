import type { JsonRecord } from "../../../types";
import type { CascadeOpenPosition, CascadePositionIntent } from "../../../strategy/cascade/types";
import { nullableMarkPriceForInstrument, type NullableMarkPriceContext } from "../book/BookViews";
import {
  applyCascadeManualCloseSideEffects,
  buildCascadeManualCloseRuntimeResult,
  type CascadeManualCloseResponse
} from "./CascadeManualCloseRuntime";

export interface TradingCascadeManualCloseInput {
  readonly positions: readonly CascadeOpenPosition[];
  readonly positionId: string;
  readonly actor: string;
  readonly reason: string;
  readonly observedAt: string;
  readonly markPriceContext: NullableMarkPriceContext;
}

export interface TradingCascadeManualCloseHandlers {
  readonly requestManualClose: (
    positionId: string,
    observedAt: string,
    markPrice: number
  ) => { readonly intents: readonly CascadePositionIntent[] } | null;
  readonly dispatchIntent: (intent: CascadePositionIntent) => void;
  readonly logManualClose: (metadata: JsonRecord) => void;
  readonly publishManualClose: (payload: JsonRecord, correlationId: string) => void;
  readonly persistPositions: () => void;
}

export function closeTradingCascadePosition(
  input: TradingCascadeManualCloseInput,
  handlers: TradingCascadeManualCloseHandlers
): CascadeManualCloseResponse {
  const closeResult = buildCascadeManualCloseRuntimeResult({
    positions: input.positions,
    positionId: input.positionId,
    actor: input.actor,
    reason: input.reason,
    observedAt: input.observedAt,
    markPriceForInstrument: (instrumentCode) =>
      nullableMarkPriceForInstrument(input.markPriceContext, instrumentCode),
    requestManualClose: handlers.requestManualClose
  });

  return applyCascadeManualCloseSideEffects(closeResult, handlers);
}
