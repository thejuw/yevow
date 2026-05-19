import type {
  AnomalyStatus,
  DomAnalysisSnapshot,
  EngineState,
  InternalOrderBook
} from "../../../types";
import { microstructureFromBook } from "../book/BookReconstruction";

export interface AnomalyEmergencyPauseStateInput {
  readonly currentState: EngineState;
  readonly book: InternalOrderBook;
  readonly dom: DomAnalysisSnapshot;
  readonly anomaly: AnomalyStatus;
  readonly internalOrderBookDepth: number;
  readonly observedAt: string;
}

export function stateAfterAnomalyEmergencyPause(
  input: AnomalyEmergencyPauseStateInput
): EngineState {
  return {
    ...input.currentState,
    mode: "HALTED",
    processedTicks: input.currentState.processedTicks + 1,
    internalOrderBookDepth: input.internalOrderBookDepth,
    microstructure: microstructureFromBook(input.book),
    dom: input.dom,
    anomaly: input.anomaly,
    risk: {
      ...input.currentState.risk,
      killSwitch: true,
      updatedAt: input.observedAt
    },
    heartbeatAt: input.observedAt,
    updatedAt: input.observedAt
  };
}
