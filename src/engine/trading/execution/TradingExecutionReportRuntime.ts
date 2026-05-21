import type {
  EngineState,
  ExecutionReport,
  InternalOrderBook,
  InventoryState,
  MicrostructureMetrics
} from "../../../types";
import { currentMarkPriceForInstrument } from "../book/BookViews";
import {
  applyExecutionReportFlow,
  type ExecutionReportRuntimeUpdate,
  type ExecutionReportSideEffectHandlers
} from "./ExecutionReportRuntime";

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
