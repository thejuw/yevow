import type { MarketTick } from "../../../types";
import type { OpenInterestPoint } from "../types";

export class OpenInterestTracker {
  private readonly latest = new Map<string, OpenInterestPoint>();

  ingestTick(tick: MarketTick): OpenInterestPoint | null {
    if (typeof tick.openInterest !== "number" || !Number.isFinite(tick.openInterest)) {
      return null;
    }

    const previous = this.latest.get(tick.instrumentCode);
    const point: OpenInterestPoint = {
      instrumentCode: tick.instrumentCode,
      observedAt: tick.receivedAt,
      openInterest: tick.openInterest,
      delta: previous ? tick.openInterest - previous.openInterest : 0
    };

    this.latest.set(tick.instrumentCode, point);
    return point;
  }

  snapshot(instrumentCode: string): OpenInterestPoint | null {
    const point = this.latest.get(instrumentCode);
    return point ? { ...point } : null;
  }
}
