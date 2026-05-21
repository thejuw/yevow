import { CASCADE_POSITIONS_KEY } from "../../../TradingEngineConstants";
import type { EngineState, GlobalRiskConfig, JsonRecord, TradeIntent } from "../../../types";
import type { CascadeOpenPosition, CascadePositionIntent } from "../../../strategy/cascade/types";
import { nullableMarkPriceForInstrument, type NullableMarkPriceContext } from "../book/BookViews";
import {
  applyCascadeManualCloseSideEffects,
  buildCascadeManualCloseRuntimeResult,
  type CascadeManualCloseResponse
} from "./CascadeManualCloseRuntime";
import { buildCascadeExitTradeIntentForTarget } from "./CascadeTradeIntents";
import {
  dispatchTradingExecutionIntentForTarget,
  type TradingExecutionDispatchTarget
} from "../execution/TradingExecutionDispatchRuntime";
import { putTradingStorageForTargetOrHandler } from "../state/StorageWriteGuard";

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
  readonly cachedConfig: GlobalRiskConfig;
  readonly orderBook: NullableMarkPriceContext["orderBook"];
  readonly engineState: Pick<EngineState, "assetMatrix" | "engineId" | "microstructure">;
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
  dispatchExecution?(intent: TradeIntent): Promise<void>;
  publish(type: string, payload: Record<string, unknown>, correlationId?: string): void;
  safeStoragePut?(key: string, value: unknown, reason: string): Promise<void>;
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
        const tradeIntent = buildCascadeExitTradeIntentForTarget(target, intent, observedAt);
        target.state.waitUntil(
          target.dispatchExecution
            ? target.dispatchExecution(tradeIntent)
            : dispatchTradingExecutionIntentForTarget(
                tradeIntent,
                0,
                target as unknown as TradingExecutionDispatchTarget
              )
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
          putTradingStorageForTargetOrHandler(
            target,
            CASCADE_POSITIONS_KEY,
            target.cascadePositionManager.snapshot(),
            "CASCADE_POSITION_MANUAL_CLOSE"
          )
        );
      }
    }
  );
}
