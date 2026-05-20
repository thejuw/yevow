import { isOpenCascadePosition } from "../helpers/RuntimeHelpers";
import { roundMetric } from "../book/SortedBookSide";
import type { AgentSignal, JsonRecord } from "../../../types";
import type {
  AbsorptionConfirmed,
  CascadeEvent,
  CascadeOpenPosition
} from "../../../strategy/cascade/types";

export interface CascadeActiveSnapshotInput {
  readonly events: Iterable<CascadeEvent>;
  readonly absorptionsById: ReadonlyMap<string, AbsorptionConfirmed>;
  readonly positions: readonly CascadeOpenPosition[];
  readonly maxAgeMs: number;
  readonly nowMs: number;
}

export function currentCascadeActiveSnapshot(input: CascadeActiveSnapshotInput): JsonRecord[] {
  const positionsByCascade = new Map(
    input.positions.map((position) => [position.cascadeId, position])
  );

  return [...input.events]
    .map((cascade) => {
      const absorption = input.absorptionsById.get(cascade.cascadeId) ?? null;
      const position = positionsByCascade.get(cascade.cascadeId) ?? null;
      const phase = position
        ? isOpenCascadePosition(position)
          ? "POSITION_OPEN"
          : "POSITION_CLOSED"
        : absorption
          ? "ABSORPTION_CONFIRMED"
          : "DETECTED";

      return {
        cascadeId: cascade.cascadeId,
        instrumentCode: cascade.instrumentCode,
        direction: cascade.direction,
        phase,
        liquidationNotional: roundMetric(cascade.liquidationNotional, 2),
        liquidationCount: cascade.liquidationCount,
        zScore: roundMetric(cascade.zScore, 4),
        directionalPct: roundMetric(cascade.directionalPct, 4),
        priceMoveAtr: roundMetric(cascade.priceMoveAtr, 4),
        detectedAt: cascade.detectedAt,
        absorption: absorption ? (absorption as unknown as JsonRecord) : null,
        position: position ? (position as unknown as JsonRecord) : null
      };
    })
    .filter((cascade) => {
      if (cascade.phase === "POSITION_OPEN") {
        return true;
      }

      return (
        cascade.phase !== "POSITION_CLOSED" &&
        input.nowMs - Date.parse(cascade.detectedAt) <= input.maxAgeMs
      );
    })
    .sort((left, right) => Date.parse(right.detectedAt) - Date.parse(left.detectedAt))
    .slice(0, 50);
}

export function currentCascadeSignalSnapshot(
  signals: readonly AgentSignal[],
  limit: number
): JsonRecord[] {
  return signals
    .filter((signal) => {
      const context = signal.featureVector;
      const risk = signal.riskContext;
      return (
        typeof context.cascadeId === "string" ||
        typeof risk.cascadeId === "string" ||
        signal.rationale.toLowerCase().includes("cascade")
      );
    })
    .slice(-limit)
    .reverse()
    .map((signal) => ({
      signalId: signal.signalId,
      traceId: signal.traceId,
      sourceAgent: signal.sourceAgent,
      targetAgent: signal.targetAgent,
      instrumentCode: signal.instrumentCode,
      action: signal.action,
      confidence: signal.confidence,
      expectedValue: signal.expectedValue,
      maxSlippageBps: signal.maxSlippageBps,
      rationale: signal.rationale,
      outcome: signal.riskContext.outcome ?? "EMITTED",
      closeReason: signal.riskContext.closeReason ?? null,
      cascadeId: signal.featureVector.cascadeId ?? signal.riskContext.cascadeId ?? null,
      createdAt: signal.createdAt,
      featureVector: signal.featureVector,
      riskContext: signal.riskContext
    }));
}

export interface CascadePositionSnapshotInput {
  readonly positions: readonly CascadeOpenPosition[];
  readonly nowMs: number;
  readonly markPriceForInstrument: (instrumentCode: string) => number | null;
}

export function currentCascadePositionSnapshot(input: CascadePositionSnapshotInput): JsonRecord[] {
  return input.positions
    .map((position) => {
      const markPrice = input.markPriceForInstrument(position.instrumentCode);
      const unrealizedPnl =
        markPrice === null
          ? null
          : roundMetric(
              (position.direction === "LONG"
                ? markPrice - position.entryPrice
                : position.entryPrice - markPrice) * position.remainingSize,
              8
            );
      const unrealizedR =
        unrealizedPnl === null || position.rDistance <= 0 || position.remainingSize <= 0
          ? null
          : roundMetric(unrealizedPnl / (position.rDistance * position.remainingSize), 6);
      const timeStopMs = Date.parse(position.timeStopAt);

      return {
        ...position,
        targets: position.targets as unknown as JsonRecord,
        markPrice,
        unrealizedPnl,
        unrealizedR,
        timeToTimeStopMs: Number.isFinite(timeStopMs) ? Math.max(0, timeStopMs - input.nowMs) : null
      };
    })
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

export interface CascadeHeatSnapshotInput {
  readonly positions: readonly CascadeOpenPosition[];
  readonly currentHeatPct: number;
  readonly heatCapPct: number;
  readonly updatedAt: string;
}

export function currentCascadeHeatSnapshot(input: CascadeHeatSnapshotInput): JsonRecord {
  const remainingRiskUsd = input.positions
    .filter(isOpenCascadePosition)
    .reduce((sum, position) => sum + position.rDistance * position.remainingSize, 0);

  return {
    currentHeatPct: roundMetric(input.currentHeatPct, 8),
    heatCapPct: roundMetric(input.heatCapPct, 8),
    percentOfCap:
      input.heatCapPct > 0 ? roundMetric(input.currentHeatPct / input.heatCapPct, 8) : 0,
    openPositionCount: input.positions.filter(isOpenCascadePosition).length,
    remainingRiskUsd: roundMetric(remainingRiskUsd, 2),
    updatedAt: input.updatedAt
  };
}
