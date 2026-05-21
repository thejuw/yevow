import { CASCADE_POSITIONS_KEY } from "../../../TradingEngineConstants";
import type { EngineState, JsonRecord, TradeIntent } from "../../../types";
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

export interface TradingCascadeManualCloseTarget {
  readonly orderBook: NullableMarkPriceContext["orderBook"];
  readonly engineState: Pick<EngineState, "assetMatrix" | "microstructure">;
  readonly cascadePositionManager: {
    snapshot(): readonly CascadeOpenPosition[];
    requestManualClose(
      positionId: string,
      observedAt: string,
      markPrice: number
    ): { readonly intents: readonly CascadePositionIntent[] } | null;
  };
  readonly state: {
    waitUntil(work: Promise<void>): void;
  };
  readonly logger: {
    warn(eventType: string, message: string, telemetry?: JsonRecord): void;
  };
  tradeIntentFromCascadePositionIntent(
    intent: CascadePositionIntent,
    observedAt: string
  ): TradeIntent;
  dispatchExecution(intent: TradeIntent): Promise<void>;
  publish(type: string, payload: Record<string, unknown>, correlationId?: string): void;
  safeStoragePut(key: string, value: unknown, reason: string): Promise<void>;
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

export function closeTradingEngineCascadePosition(
  input: Pick<TradingCascadeManualCloseInput, "positionId" | "actor" | "reason">,
  target: TradingCascadeManualCloseTarget
): CascadeManualCloseResponse {
  const observedAt = new Date().toISOString();

  return closeTradingCascadePosition(
    {
      positions: target.cascadePositionManager.snapshot(),
      positionId: input.positionId,
      actor: input.actor,
      reason: input.reason,
      observedAt,
      markPriceContext: {
        orderBook: target.orderBook,
        assetMatrix: target.engineState.assetMatrix,
        microstructure: target.engineState.microstructure
      }
    },
    {
      requestManualClose: (id, closeObservedAt, markPrice) =>
        target.cascadePositionManager.requestManualClose(id, closeObservedAt, markPrice),
      dispatchIntent: (intent) => {
        target.state.waitUntil(
          target.dispatchExecution(target.tradeIntentFromCascadePositionIntent(intent, observedAt))
        );
      },
      logManualClose: (metadata) => {
        target.logger.warn(
          "CASCADE_POSITION_MANUAL_CLOSE",
          "Operator requested cascade position close",
          metadata
        );
      },
      publishManualClose: (payload, correlationId) => {
        target.publish("CASCADE_POSITION_MANUAL_CLOSE", payload, correlationId);
      },
      persistPositions: () => {
        target.state.waitUntil(
          target.safeStoragePut(
            CASCADE_POSITIONS_KEY,
            target.cascadePositionManager.snapshot(),
            "CASCADE_POSITION_MANUAL_CLOSE"
          )
        );
      }
    }
  );
}
