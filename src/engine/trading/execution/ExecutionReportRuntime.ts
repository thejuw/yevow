import {
  applyExecutionAccounting,
  executionQualityFromAccounting,
  stateAfterExecutionAccounting,
  type ExecutionAccountingResult,
  type ExecutionQualityRecord
} from "../../ExecutionAccounting";
import type { EngineState, ExecutionReport, InventoryState } from "../../../types";

export interface ExecutionReportRuntimeUpdateInput {
  readonly state: EngineState;
  readonly report: ExecutionReport;
  readonly markPrice: (instrumentCode: string, fallback: number) => number;
  readonly calculateInventory: (
    observedAt: string,
    openPositions: EngineState["openPositions"]
  ) => InventoryState;
}

export interface ExecutionReportRuntimeUpdate {
  readonly accounting: ExecutionAccountingResult;
  readonly inventory: InventoryState;
  readonly executionQuality: ExecutionQualityRecord;
  readonly adverseSelectionMarkPrice: number;
  readonly nextState: EngineState;
}

export interface ExecutionReportSideEffectsInput {
  readonly report: ExecutionReport;
  readonly update: ExecutionReportRuntimeUpdate;
  readonly oracleRegime: EngineState["oracle"]["regime"];
}

export interface ExecutionReportSideEffectHandlers {
  readonly observeAdverseSelection: (
    report: ExecutionReport,
    order: ExecutionAccountingResult["order"],
    markPrice: number,
    oracleRegime: EngineState["oracle"]["regime"]
  ) => void;
  readonly recordExecutionQuality: (record: ExecutionQualityRecord) => void;
  readonly applyState: (state: EngineState) => Promise<void>;
  readonly recordExecution: (tradeExecution: ExecutionAccountingResult["tradeExecution"]) => void;
  readonly publishTradeExecution: (
    tradeExecution: ExecutionAccountingResult["tradeExecution"]
  ) => void;
}

export interface ExecutionReportFlowInput {
  readonly state: EngineState;
  readonly report: ExecutionReport;
  readonly oracleRegime: EngineState["oracle"]["regime"];
}

export interface ExecutionReportFlowHandlers extends ExecutionReportSideEffectHandlers {
  readonly markPrice: (instrumentCode: string, fallback: number) => number;
  readonly calculateInventory: (
    observedAt: string,
    openPositions: EngineState["openPositions"]
  ) => InventoryState;
}

export function buildExecutionReportRuntimeUpdate(
  input: ExecutionReportRuntimeUpdateInput
): ExecutionReportRuntimeUpdate {
  const accounting = applyExecutionAccounting({
    state: input.state,
    report: input.report,
    markPrice: input.markPrice
  });
  const inventory = input.calculateInventory(accounting.observedAt, accounting.openPositions);
  const adverseSelectionMarkPrice = input.markPrice(
    accounting.order.instrumentCode,
    accounting.order.price
  );

  return {
    accounting,
    inventory,
    executionQuality: executionQualityFromAccounting(input.report, accounting),
    adverseSelectionMarkPrice,
    nextState: stateAfterExecutionAccounting({
      state: input.state,
      accounting,
      inventory
    })
  };
}

export async function applyExecutionReportSideEffects(
  input: ExecutionReportSideEffectsInput,
  handlers: ExecutionReportSideEffectHandlers
): Promise<void> {
  handlers.observeAdverseSelection(
    input.report,
    input.update.accounting.order,
    input.update.adverseSelectionMarkPrice,
    input.oracleRegime
  );
  handlers.recordExecutionQuality(input.update.executionQuality);
  await handlers.applyState(input.update.nextState);
  handlers.recordExecution(input.update.accounting.tradeExecution);
  handlers.publishTradeExecution(input.update.accounting.tradeExecution);
}

export async function applyExecutionReportFlow(
  input: ExecutionReportFlowInput,
  handlers: ExecutionReportFlowHandlers
): Promise<ExecutionReportRuntimeUpdate> {
  const update = buildExecutionReportRuntimeUpdate({
    state: input.state,
    report: input.report,
    markPrice: handlers.markPrice,
    calculateInventory: handlers.calculateInventory
  });

  await applyExecutionReportSideEffects(
    {
      report: input.report,
      update,
      oracleRegime: input.oracleRegime
    },
    handlers
  );

  return update;
}
