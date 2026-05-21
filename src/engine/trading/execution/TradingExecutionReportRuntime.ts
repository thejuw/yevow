import type {
  EngineState,
  ExecutionReport,
  InternalOrderBook,
  InventoryState,
  MicrostructureMetrics,
  TradeExecution
} from "../../../types";
import { ENGINE_STATE_KEY } from "../../../TradingEngineConstants";
import { currentMarkPriceForInstrument } from "../book/BookViews";
import {
  calculateTradingInventoryStateForTarget,
  type TradingInventoryStateTarget
} from "../inventory/TradingInventoryStateRuntime";
import {
  applyExecutionReportFlow,
  type ExecutionReportRuntimeUpdate,
  type ExecutionReportSideEffectHandlers
} from "./ExecutionReportRuntime";
import { putTradingStorageForTargetOrHandler } from "../state/StorageWriteGuard";

export interface TradingExecutionReportInput {
  readonly state: EngineState;
  readonly report: ExecutionReport;
  readonly orderBook: Map<string, InternalOrderBook>;
  readonly microstructure: MicrostructureMetrics;
}

export interface TradingExecutionReportHandlers extends Omit<
  ExecutionReportSideEffectHandlers,
  "applyState"
> {
  readonly calculateInventory: (
    observedAt: string,
    openPositions: EngineState["openPositions"]
  ) => InventoryState;
  readonly applyState: (state: EngineState) => Promise<void>;
}

export interface TradingExecutionReportTarget {
  engineState: EngineState;
  readonly orderBook: Map<string, InternalOrderBook>;
  readonly adverseSelectionModel: {
    observeExecutionReport(
      report: ExecutionReport,
      order: Parameters<ExecutionReportSideEffectHandlers["observeAdverseSelection"]>[1],
      markPrice: number,
      oracleRegime: EngineState["oracle"]["regime"]
    ): void;
  };
  readonly logger: {
    recordExecutionQuality(
      record: Parameters<ExecutionReportSideEffectHandlers["recordExecutionQuality"]>[0]
    ): void;
    recordExecution(execution: TradeExecution): void;
  };
  calculateInventoryState?(
    observedAt: string,
    openPositions: EngineState["openPositions"]
  ): InventoryState;
  safeStoragePut?(key: string, value: unknown, reason: string): Promise<void>;
  publish(type: string, payload: Record<string, unknown>, correlationId?: string): void;
}

export function markPriceForTradingExecutionReport(
  input: Pick<TradingExecutionReportInput, "orderBook" | "microstructure">,
  instrumentCode: string,
  fallback: number
): number {
  return currentMarkPriceForInstrument(
    {
      orderBook: input.orderBook,
      microstructure: input.microstructure
    },
    instrumentCode,
    fallback
  );
}

export function applyTradingExecutionReport(
  input: TradingExecutionReportInput,
  handlers: TradingExecutionReportHandlers
): Promise<ExecutionReportRuntimeUpdate> {
  return applyExecutionReportFlow(
    {
      state: input.state,
      report: input.report,
      oracleRegime: input.state.oracle.regime
    },
    {
      markPrice: (instrumentCode, fallback) =>
        markPriceForTradingExecutionReport(input, instrumentCode, fallback),
      calculateInventory: handlers.calculateInventory,
      observeAdverseSelection: handlers.observeAdverseSelection,
      recordExecutionQuality: handlers.recordExecutionQuality,
      applyState: handlers.applyState,
      recordExecution: handlers.recordExecution,
      publishTradeExecution: handlers.publishTradeExecution
    }
  );
}

export function applyTradingExecutionReportForTarget(
  report: ExecutionReport,
  target: TradingExecutionReportTarget
): Promise<ExecutionReportRuntimeUpdate> {
  return applyTradingExecutionReport(
    {
      state: target.engineState,
      report,
      orderBook: target.orderBook,
      microstructure: target.engineState.microstructure
    },
    {
      calculateInventory: (observedAt, openPositions) =>
        target.calculateInventoryState
          ? target.calculateInventoryState(observedAt, openPositions)
          : calculateTradingInventoryStateForTarget(
              { observedAt, positions: openPositions },
              target as unknown as TradingInventoryStateTarget
            ),
      observeAdverseSelection: (executionReport, order, markPrice, oracleRegime) => {
        target.adverseSelectionModel.observeExecutionReport(
          executionReport,
          order,
          markPrice,
          oracleRegime
        );
      },
      recordExecutionQuality: (record) => {
        target.logger.recordExecutionQuality(record);
      },
      applyState: async (state) => {
        target.engineState = state;
        await putTradingStorageForTargetOrHandler(
          target,
          ENGINE_STATE_KEY,
          target.engineState,
          "EXECUTION_REPORT"
        );
      },
      recordExecution: (tradeExecution) => {
        target.logger.recordExecution(tradeExecution);
      },
      publishTradeExecution: (tradeExecution) => {
        target.publish(
          "TRADE_EXECUTION_UPDATE",
          tradeExecution as unknown as Record<string, unknown>,
          tradeExecution.tradeId
        );
      }
    }
  );
}
