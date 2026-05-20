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
