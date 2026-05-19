import { clampNumber } from "./HawkesFlowTracker";

interface ClusterHealth {
  score: number;
  failures: number;
  heartbeatLatencyMs: number | null;
  cooldownUntilMs: number;
}

export class ClockSyncTracker {
  private offsetMs: number | null = null;

  constructor(
    private readonly alpha: number,
    private readonly maxOffsetMs: number
  ) {}

  observe(exchangeTimestamp: string, receivedAt: string): { timestamp: string; offsetMs: number } {
    const exchangeMs = Date.parse(exchangeTimestamp);
    const receivedMs = Date.parse(receivedAt);

    if (!Number.isFinite(exchangeMs) || !Number.isFinite(receivedMs)) {
      return { timestamp: receivedAt, offsetMs: this.currentOffsetMs() ?? 0 };
    }

    const observedOffset = clampNumber(
      receivedMs - exchangeMs,
      -this.maxOffsetMs,
      this.maxOffsetMs
    );
    this.offsetMs =
      this.offsetMs === null
        ? observedOffset
        : this.offsetMs + this.alpha * (observedOffset - this.offsetMs);

    return {
      timestamp: new Date(exchangeMs + this.offsetMs).toISOString(),
      offsetMs: Math.round(this.offsetMs)
    };
  }

  currentOffsetMs(): number | null {
    return this.offsetMs === null ? null : Math.round(this.offsetMs);
  }
}

export class ClusterPool {
  private activeIndex = 0;
  private readonly health = new Map<string, ClusterHealth>();

  constructor(private readonly urls: string[]) {
    for (const url of urls) {
      this.health.set(url, {
        score: 1,
        failures: 0,
        heartbeatLatencyMs: null,
        cooldownUntilMs: 0
      });
    }
  }

  activeUrl(): string {
    return this.urls[this.activeIndex] ?? this.urls[0];
  }

  recordHeartbeat(url: string, latencyMs: number): void {
    const entry = this.health.get(url) ?? defaultClusterHealth();
    const latencyPenalty = Math.min(0.5, latencyMs / 10_000);
    entry.score = Math.min(1, entry.score * 0.9 + (1 - latencyPenalty) * 0.1);
    entry.failures = 0;
    entry.heartbeatLatencyMs = latencyMs;
    entry.cooldownUntilMs = 0;
    this.health.set(url, entry);
  }

  recordFailure(url: string): void {
    const entry = this.health.get(url) ?? defaultClusterHealth();
    entry.failures += 1;
    entry.score = Math.max(0, entry.score - 0.25);
    if (entry.failures >= 2) {
      entry.cooldownUntilMs = Date.now() + Math.min(60_000, entry.failures * 5_000);
    }
    this.health.set(url, entry);
    this.maybePromote();
  }

  activeHeartbeatLatencyMs(): number | null {
    return this.health.get(this.activeUrl())?.heartbeatLatencyMs ?? null;
  }

  private maybePromote(): void {
    const activeUrl = this.activeUrl();
    const activeScore = this.health.get(activeUrl)?.score ?? 0;
    const best = this.urls
      .map((url, index) => {
        const health = this.health.get(url);
        const coolingDown = (health?.cooldownUntilMs ?? 0) > Date.now();
        return {
          url,
          index,
          score: coolingDown ? -1 : (health?.score ?? 0)
        };
      })
      .sort((left, right) => right.score - left.score)[0];

    if (best && best.index !== this.activeIndex && best.score > activeScore + 0.2) {
      this.activeIndex = best.index;
    }
  }
}

function defaultClusterHealth(): ClusterHealth {
  return {
    score: 1,
    failures: 0,
    heartbeatLatencyMs: null,
    cooldownUntilMs: 0
  };
}
