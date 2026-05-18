import type { ExecutionReport, InternalOrderBook, ManagedOrder } from "../types";

const MAX_BUCKETS = 64;
const MAX_OBSERVATIONS_PER_BUCKET = 256;

export interface AdverseSelectionObservation {
  instrumentCode: string;
  side: "BUY" | "SELL";
  regime: string;
  expectedPrice: number;
  achievedPrice: number;
  markPrice: number;
  observedAt: string;
}

export interface AdverseSelectionPenalty {
  penaltyBps: number;
  sampleCount: number;
  bucketKey: string;
}

export class AdverseSelectionModel {
  private readonly samples = new Map<string, Float32Array>();
  private readonly counts = new Map<string, number>();
  private readonly cursors = new Map<string, number>();

  observe(input: AdverseSelectionObservation): void {
    if (
      input.expectedPrice <= 0 ||
      input.achievedPrice <= 0 ||
      input.markPrice <= 0 ||
      !Number.isFinite(input.expectedPrice) ||
      !Number.isFinite(input.achievedPrice) ||
      !Number.isFinite(input.markPrice)
    ) {
      return;
    }

    const bucketKey = this.bucketKey(
      input.instrumentCode,
      input.side,
      input.regime,
      input.observedAt
    );
    const driftBps =
      input.side === "BUY"
        ? ((input.achievedPrice - input.expectedPrice) / input.expectedPrice) * 10_000
        : ((input.expectedPrice - input.achievedPrice) / input.expectedPrice) * 10_000;
    const adverseBps = Math.max(0, driftBps);
    this.writeSample(bucketKey, adverseBps);
  }

  observeExecutionReport(
    report: ExecutionReport,
    order: ManagedOrder,
    markPrice: number,
    regime: string
  ): void {
    this.observe({
      instrumentCode: order.instrumentCode,
      side: report.side ?? order.side,
      regime,
      expectedPrice: report.expectedPrice ?? order.price,
      achievedPrice: report.achievedPrice ?? report.expectedPrice ?? order.price,
      markPrice,
      observedAt: report.observedAt
    });
  }

  penaltyFor(
    instrumentCode: string,
    side: "BUY" | "SELL",
    regime: string,
    observedAt: string
  ): AdverseSelectionPenalty {
    const specificKey = this.bucketKey(instrumentCode, side, regime, observedAt);
    const fallbackKey = this.bucketKey(instrumentCode, side, "ALL", observedAt);
    const specific = this.percentile(specificKey, 0.75);

    if (specific.sampleCount >= 8) {
      return specific;
    }

    const fallback = this.percentile(fallbackKey, 0.75);
    return fallback.sampleCount > specific.sampleCount ? fallback : specific;
  }

  private writeSample(bucketKey: string, value: number): void {
    if (!this.samples.has(bucketKey)) {
      this.pruneIfNeeded();
      this.samples.set(bucketKey, new Float32Array(MAX_OBSERVATIONS_PER_BUCKET));
      this.counts.set(bucketKey, 0);
      this.cursors.set(bucketKey, 0);
    }

    const buffer = this.samples.get(bucketKey);
    if (!buffer) {
      return;
    }

    const cursor = this.cursors.get(bucketKey) ?? 0;
    buffer[cursor] = value;
    this.cursors.set(bucketKey, (cursor + 1) % MAX_OBSERVATIONS_PER_BUCKET);
    this.counts.set(
      bucketKey,
      Math.min(MAX_OBSERVATIONS_PER_BUCKET, (this.counts.get(bucketKey) ?? 0) + 1)
    );

    if (!bucketKey.includes(":ALL:")) {
      const [instrumentCode, side] = bucketKey.split(":");
      this.writeSample(`${instrumentCode}:${side}:ALL:ALL`, value);
    }
  }

  private percentile(bucketKey: string, quantile: number): AdverseSelectionPenalty {
    const buffer = this.samples.get(bucketKey);
    const count = this.counts.get(bucketKey) ?? 0;

    if (!buffer || count === 0) {
      return { penaltyBps: 0, sampleCount: 0, bucketKey };
    }

    const values: number[] = [];
    for (let index = 0; index < count; index += 1) {
      values.push(buffer[index]);
    }
    values.sort((left, right) => left - right);
    const sampleIndex = Math.min(
      values.length - 1,
      Math.max(0, Math.floor(values.length * quantile))
    );

    return {
      penaltyBps: roundMetric(values[sampleIndex], 4),
      sampleCount: count,
      bucketKey
    };
  }

  private bucketKey(
    instrumentCode: string,
    side: "BUY" | "SELL",
    regime: string,
    observedAt: string
  ): string {
    const hour = Number.isFinite(Date.parse(observedAt))
      ? new Date(observedAt).getUTCHours()
      : "ALL";
    return `${instrumentCode}:${side}:${regime}:${hour}`;
  }

  private pruneIfNeeded(): void {
    if (this.samples.size < MAX_BUCKETS) {
      return;
    }

    const firstKey = this.samples.keys().next().value;
    if (!firstKey) {
      return;
    }

    this.samples.delete(firstKey);
    this.counts.delete(firstKey);
    this.cursors.delete(firstKey);
  }
}

export function adversePenaltyForQuoteSide(
  model: AdverseSelectionModel,
  book: InternalOrderBook,
  quoteSide: "BID" | "ASK",
  regime: string,
  observedAt: string
): AdverseSelectionPenalty {
  return model.penaltyFor(
    book.instrumentCode,
    quoteSide === "BID" ? "BUY" : "SELL",
    regime,
    observedAt
  );
}

function roundMetric(value: number, precision: number): number {
  const scale = 10 ** precision;
  return Math.round(value * scale) / scale;
}
