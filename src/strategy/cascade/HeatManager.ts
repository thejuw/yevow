import type { CascadeOpenPosition, CascadeRecoveryDirection } from "./types";

export type CascadeCorrelationMatrix = Record<string, number>;

export const DEFAULT_CASCADE_CORRELATIONS: CascadeCorrelationMatrix = {
  "BTC:ETH": 0.85,
  "BTC:SOL": 0.75,
  "ETH:SOL": 0.8,
  "BTC:HYPE": 0.65,
  "ETH:HYPE": 0.6,
  "HYPE:SOL": 0.55
};

const ACTIVE_POSITION_STATUSES = new Set<CascadeOpenPosition["status"]>([
  "PENDING_ENTRY",
  "ENTERED",
  "FIRST_TARGET_HIT",
  "SECOND_TARGET_HIT"
]);

interface HeatContribution {
  instrumentCode: string;
  direction: CascadeRecoveryDirection;
  heat: number;
}

export class HeatManager {
  constructor(
    private readonly heatCapPct = 0.02,
    private readonly correlations: CascadeCorrelationMatrix = DEFAULT_CASCADE_CORRELATIONS
  ) {}

  currentHeat(positions: readonly CascadeOpenPosition[]): number {
    const longContributions: HeatContribution[] = [];
    const shortContributions: HeatContribution[] = [];

    for (const position of positions) {
      if (!isActivePosition(position) || position.totalSize <= 0 || position.remainingSize <= 0) {
        continue;
      }

      const heat = Math.max(
        0,
        (position.remainingSize / position.totalSize) * position.initialRiskPct
      );
      if (heat <= 0) {
        continue;
      }

      const contribution = {
        instrumentCode: position.instrumentCode,
        direction: position.direction,
        heat
      };

      if (position.direction === "LONG") {
        longContributions.push(contribution);
      } else {
        shortContributions.push(contribution);
      }
    }

    return roundHeat(
      this.correlatedHeat(longContributions) + this.correlatedHeat(shortContributions)
    );
  }

  wouldExceedCap(
    positions: readonly CascadeOpenPosition[],
    candidate: Pick<CascadeOpenPosition, "instrumentCode" | "direction" | "initialRiskPct">
  ): boolean {
    const synthetic: CascadeOpenPosition = {
      positionId: "__candidate__",
      signalId: "__candidate__",
      cascadeId: "__candidate__",
      instrumentCode: candidate.instrumentCode,
      direction: candidate.direction,
      status: "PENDING_ENTRY",
      entryPrice: 1,
      currentStopPrice: 0.99,
      initialStopPrice: 0.99,
      totalSize: 1,
      remainingSize: 1,
      initialRiskPct: candidate.initialRiskPct,
      rDistance: 0.01,
      targets: {
        partial1: { price: 1.02, rMultiple: 2.0, sizePct: 30 },
        partial2: { price: 1.03, rMultiple: 3.0, sizePct: 30 },
        runner: { trailingType: "ATR", trailingParam: 2, sizePct: 40 }
      },
      timeStopAt: "1970-01-01T00:00:00.000Z",
      firstTargetTaken: false,
      secondTargetTaken: false,
      enteredAt: "1970-01-01T00:00:00.000Z",
      updatedAt: "1970-01-01T00:00:00.000Z"
    };

    return this.currentHeat([...positions, synthetic]) > this.heatCapPct;
  }

  private correlatedHeat(contributions: readonly HeatContribution[]): number {
    let variance = 0;

    for (let outerIndex = 0; outerIndex < contributions.length; outerIndex += 1) {
      const outer = contributions[outerIndex];
      variance += outer.heat * outer.heat;

      for (let innerIndex = outerIndex + 1; innerIndex < contributions.length; innerIndex += 1) {
        const inner = contributions[innerIndex];
        const correlation = this.correlationFor(outer.instrumentCode, inner.instrumentCode);
        variance += 2 * Math.max(0, correlation) * outer.heat * inner.heat;
      }
    }

    return Math.sqrt(Math.max(0, variance));
  }

  private correlationFor(leftInstrument: string, rightInstrument: string): number {
    const left = baseAsset(leftInstrument);
    const right = baseAsset(rightInstrument);
    if (left === right) {
      return 1;
    }

    const key = [left, right].sort().join(":");
    return this.correlations[key] ?? 0;
  }
}

function isActivePosition(position: CascadeOpenPosition): boolean {
  return ACTIVE_POSITION_STATUSES.has(position.status);
}

function baseAsset(instrumentCode: string): string {
  return instrumentCode.split("-")[0]?.toUpperCase() ?? instrumentCode.toUpperCase();
}

function roundHeat(value: number): number {
  return Number(value.toFixed(8));
}
