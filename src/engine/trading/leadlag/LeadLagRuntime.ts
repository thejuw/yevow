import type { EngineState, JsonRecord } from "../../../types";
import { pearson, returns } from "../helpers/RuntimeHelpers";
import type { MultiScaleVolatilitySnapshot } from "../../MultiScaleVolatility";
import { roundMetric } from "../book/SortedBookSide";

export interface LeadLagSample {
  price: number;
  observedAt: string;
}

export interface LeadLagUpdateInput {
  readonly samples: Map<string, LeadLagSample[]>;
  readonly currentLeadLag: EngineState["leadLag"];
  readonly instrumentCode: string;
  readonly midPrice: number | null;
  readonly observedAt: string;
  readonly averageLatencyMs: number;
  readonly microstructureSpread: number | null;
  readonly microstructureMidPrice: number | null;
  readonly executionCostBufferBps: number;
  readonly sampleLimit: number;
}

export interface CrossAssetHypeCancelInput {
  readonly shadowReplay?: boolean;
  readonly tradingEnabled: boolean;
  readonly tickInstrumentCode: string;
  readonly volatility: MultiScaleVolatilitySnapshot | null;
  readonly observedAt: string;
  readonly leadThresholdBps: number;
  readonly cooldownMs: number;
  readonly lastCancelAtMs: number;
  readonly fallbackNowMs: number;
}

export interface CrossAssetHypeCancelDecision {
  readonly shouldCancel: boolean;
  readonly nowMs: number;
  readonly moveBps: number;
  readonly reason: string | null;
}

export interface CrossAssetHypeCancelArtifactsInput {
  readonly decision: CrossAssetHypeCancelDecision;
  readonly volatility: MultiScaleVolatilitySnapshot | null;
  readonly leadThresholdBps: number;
  readonly observedAt: string;
}

export function updateLeadLagMetrics(input: LeadLagUpdateInput): EngineState["leadLag"] {
  if (input.midPrice === null) {
    return input.currentLeadLag;
  }

  const samples = input.samples.get(input.instrumentCode) ?? [];
  samples.push({ price: input.midPrice, observedAt: input.observedAt });
  input.samples.set(input.instrumentCode, samples.slice(-input.sampleLimit));
  const instruments = [...input.samples.keys()].sort();

  if (instruments.length < 2) {
    return {
      ...input.currentLeadLag,
      sampleCount: samples.length,
      updatedAt: input.observedAt
    };
  }

  const best = findBestLeadLagRelationship(input.samples, instruments);

  if (!best) {
    return {
      ...input.currentLeadLag,
      sampleCount: samples.length,
      updatedAt: input.observedAt
    };
  }

  const lagMs = best.lagSteps * Math.max(1, input.averageLatencyMs || 1);
  const spreadCost =
    (input.microstructureSpread ?? 0) +
    (input.microstructureMidPrice ?? 0) * (input.executionCostBufferBps / 10_000);

  return {
    schemaVersion: "lead-lag.v1",
    leadInstrument: best.leadInstrument,
    lagInstrument: best.lagInstrument,
    correlation: best.correlation,
    lagMs,
    leadLagDelta: best.leadLagDelta,
    expectedValue: best.expectedValue,
    executable: best.expectedValue > spreadCost,
    sampleCount: best.sampleCount,
    updatedAt: input.observedAt
  };
}

export function evaluateCrossAssetHypeQuoteCancel(
  input: CrossAssetHypeCancelInput
): CrossAssetHypeCancelDecision {
  if (
    input.shadowReplay ||
    !input.tradingEnabled ||
    input.tickInstrumentCode !== "btc-usd" ||
    !input.volatility ||
    input.volatility.midPrice <= 0
  ) {
    return {
      shouldCancel: false,
      nowMs: resolveObservedAtMs(input.observedAt, input.fallbackNowMs),
      moveBps: 0,
      reason: "INELIGIBLE"
    };
  }

  const moveBps = Math.abs(input.volatility.ret) * 10_000;
  if (moveBps < input.leadThresholdBps && !input.volatility.jumpDetected) {
    return {
      shouldCancel: false,
      nowMs: resolveObservedAtMs(input.observedAt, input.fallbackNowMs),
      moveBps,
      reason: "BELOW_THRESHOLD"
    };
  }

  const nowMs = resolveObservedAtMs(input.observedAt, input.fallbackNowMs);
  if (nowMs - input.lastCancelAtMs < input.cooldownMs) {
    return {
      shouldCancel: false,
      nowMs,
      moveBps,
      reason: "COOLDOWN"
    };
  }

  return {
    shouldCancel: true,
    nowMs,
    moveBps,
    reason: "BTC_LEAD_MOVE"
  };
}

export function crossAssetHypeCancelLogMetadata(
  input: CrossAssetHypeCancelArtifactsInput
): JsonRecord {
  return {
    leadInstrument: "btc-usd",
    lagInstrument: "hype-usd",
    moveBps: roundMetric(input.decision.moveBps, 4),
    thresholdBps: input.leadThresholdBps,
    jumpDetected: input.volatility?.jumpDetected ?? false,
    jumpZScore: roundMetric(input.volatility?.jumpZScore ?? 0, 4)
  };
}

export function crossAssetHypeCancelTelemetry(
  input: CrossAssetHypeCancelArtifactsInput
): JsonRecord {
  return {
    instrumentCode: "hype-usd",
    reason: "BTC_LEAD_MOVE",
    moveBps: input.decision.moveBps,
    jumpDetected: input.volatility?.jumpDetected ?? false,
    observedAt: input.observedAt
  };
}

interface LeadLagRelationship {
  leadInstrument: string;
  lagInstrument: string;
  correlation: number;
  lagSteps: number;
  sampleCount: number;
  leadLagDelta: number;
  expectedValue: number;
}

function resolveObservedAtMs(observedAt: string, fallbackNowMs: number): number {
  const parsed = Date.parse(observedAt);
  return Number.isFinite(parsed) ? parsed : fallbackNowMs;
}

function findBestLeadLagRelationship(
  samples: Map<string, LeadLagSample[]>,
  instruments: string[]
): LeadLagRelationship | null {
  let best: LeadLagRelationship | null = null;

  for (const leadInstrument of instruments) {
    for (const lagInstrument of instruments) {
      if (leadInstrument === lagInstrument) {
        continue;
      }

      const lead = samples.get(leadInstrument) ?? [];
      const lag = samples.get(lagInstrument) ?? [];
      const sampleCount = Math.min(lead.length, lag.length, 100);

      if (sampleCount < 10) {
        continue;
      }

      const leadPrices = lead.slice(-sampleCount).map((sample) => sample.price);
      const lagPrices = lag.slice(-sampleCount).map((sample) => sample.price);

      for (let lagSteps = 1; lagSteps <= Math.min(10, sampleCount - 2); lagSteps += 1) {
        const leadReturns = returns(leadPrices.slice(0, -lagSteps));
        const lagReturns = returns(lagPrices.slice(lagSteps));
        const correlation = pearson(leadReturns, lagReturns);

        if (correlation === null) {
          continue;
        }

        const lastLeadIndex = leadPrices.length - 1;
        const lastLagIndex = lagPrices.length - 1;
        const leadMove = leadPrices[lastLeadIndex] - leadPrices[lastLeadIndex - 1];
        const lagMove = lagPrices[lastLagIndex] - lagPrices[lastLagIndex - 1];
        const leadLagDelta = leadMove - lagMove;
        const expectedValue = Math.abs(leadLagDelta) * Math.abs(correlation);

        if (!best || expectedValue > best.expectedValue) {
          best = {
            leadInstrument,
            lagInstrument,
            correlation,
            lagSteps,
            sampleCount,
            leadLagDelta,
            expectedValue
          };
        }
      }
    }
  }

  return best;
}
