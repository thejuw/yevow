import type {
  ISO8601,
  LiquidationCascadeCluster,
  LiquidationEventRecord,
  LiquidationHeatmapLevel,
  LiquidationHeatmapState,
  LiquidationSide
} from "../types";

export const LIQUIDATION_HEATMAP_STORAGE_KEY = "agent:heatmap:liquidations";

const DEFAULT_BIN_SIZE = 100;
const DEFAULT_CLUSTER_THRESHOLD_USD = 10_000_000;
const DEFAULT_CASCADE_DISTANCE_PCT = 0.005;
const MAX_LEVELS = 80;
const MAX_RECENT_EVENTS = 100;

export interface HeatmapAgentConfig {
  coin?: string;
  instrumentCode?: string;
  sourceExchange?: string;
  binSize?: number;
  clusterThresholdUsd?: number;
  cascadeDistancePct?: number;
}

export interface LiquidationEventContext {
  instrumentCode?: string | null;
  sourceExchange?: string | null;
  midPrice?: number | null;
  observedAt: ISO8601;
}

export class HeatmapAgent {
  private readonly coin: string;
  private readonly instrumentCode: string;
  private readonly sourceExchange: string;
  private readonly binSize: number;
  private readonly clusterThresholdUsd: number;
  private readonly cascadeDistancePct: number;
  private state: LiquidationHeatmapState;

  constructor(config: HeatmapAgentConfig = {}) {
    this.coin = (config.coin ?? "BTC").toUpperCase();
    this.instrumentCode = (config.instrumentCode ?? `${this.coin.toLowerCase()}-usd`).toLowerCase();
    this.sourceExchange = normalizeSourceExchange(config.sourceExchange);
    this.binSize = positiveNumber(config.binSize, DEFAULT_BIN_SIZE);
    this.clusterThresholdUsd = positiveNumber(
      config.clusterThresholdUsd,
      DEFAULT_CLUSTER_THRESHOLD_USD
    );
    this.cascadeDistancePct = positiveNumber(
      config.cascadeDistancePct,
      DEFAULT_CASCADE_DISTANCE_PCT
    );
    this.state = defaultLiquidationHeatmapState(
      this.instrumentCode,
      this.sourceExchange,
      this.binSize,
      this.clusterThresholdUsd,
      this.cascadeDistancePct
    );
  }

  hydrate(persisted: LiquidationHeatmapState | null | undefined): void {
    if (!persisted || persisted.schemaVersion !== "liquidation-heatmap.v1") {
      return;
    }

    const levels = eventBackedLevels(sanitizeLevels(persisted.levels)).slice(0, MAX_LEVELS);
    const clusters = eventBackedClusters(sanitizeClusters(persisted.clusters)).slice(0, MAX_LEVELS);

    this.state = {
      ...defaultLiquidationHeatmapState(
        this.instrumentCode,
        this.sourceExchange,
        this.binSize,
        this.clusterThresholdUsd,
        this.cascadeDistancePct
      ),
      ...persisted,
      instrumentCode: persisted.instrumentCode ?? this.instrumentCode,
      source_exchange: normalizeSourceExchange(persisted.source_exchange),
      binSize: positiveNumber(persisted.binSize, this.binSize),
      clusterThresholdUsd: positiveNumber(
        persisted.clusterThresholdUsd,
        this.clusterThresholdUsd
      ),
      cascadeDistancePct: positiveNumber(
        persisted.cascadeDistancePct,
        this.cascadeDistancePct
      ),
      levels,
      clusters,
      nearestCascade: persisted.nearestCascade
        ? eventBackedCluster(sanitizeCluster(persisted.nearestCascade)) ??
          nearestCluster(clusters, this.instrumentCode, null)
        : nearestCluster(clusters, this.instrumentCode, null),
      recentEvents: sanitizeEvents(persisted.recentEvents).slice(-MAX_RECENT_EVENTS),
      totalEstimatedNotionalUsd: roundMetric(
        levels.reduce((sum, level) => sum + level.estimatedNotionalUsd, 0),
        2
      ),
      sampledWalletCount: 0,
      lastSampleAt: null
    };
  }

  recordLiquidationEvent(
    raw: unknown,
    context: LiquidationEventContext
  ): LiquidationHeatmapState {
    const event = parseLiquidationEvent(raw, context);

    if (!event) {
      return this.snapshot();
    }

    const levels = [...this.state.levels];

    if (event.price !== null && event.notionalUsd !== null && event.notionalUsd > 0) {
      const instrumentCode = event.instrumentCode ?? context.instrumentCode ?? this.instrumentCode;
      levels.push({
        levelId: `liq:event:${instrumentCode}:${event.side}:${bucketStart(event.price, this.binSize)}`,
        instrumentCode,
        source_exchange: normalizeSourceExchange(context.sourceExchange ?? this.sourceExchange),
        side: event.side,
        priceStart: bucketStart(event.price, this.binSize),
        priceEnd: bucketStart(event.price, this.binSize) + this.binSize,
        centerPrice: bucketStart(event.price, this.binSize) + this.binSize / 2,
        estimatedNotionalUsd: event.notionalUsd,
        estimatedBaseSize: event.price > 0 ? event.notionalUsd / event.price : 0,
        walletCount: event.liquidatedUser ? 1 : 0,
        eventCount: 1,
        confidence: 1,
        source: "USER_EVENT",
        updatedAt: context.observedAt
      });
    }

    this.state = {
      ...this.rebuildState(
        mergeLevels(levels, this.binSize, context.observedAt),
        {
          [context.instrumentCode ?? this.instrumentCode]:
            context.midPrice ?? this.state.nearestCascade?.centerPrice ?? null
        },
        context.observedAt
      ),
      recentEvents: [event, ...this.state.recentEvents].slice(0, MAX_RECENT_EVENTS)
    };

    return this.snapshot();
  }

  nearestCascade(
    instrumentCode: string | null | undefined,
    midPrice: number | null | undefined
  ): LiquidationCascadeCluster | null {
    return nearestCluster(
      this.state.clusters,
      instrumentCode ?? this.instrumentCode,
      midPrice ?? null
    );
  }

  snapshot(): LiquidationHeatmapState {
    return {
      ...this.state,
      levels: this.state.levels.map((level) => ({ ...level })),
      clusters: this.state.clusters.map((cluster) => ({ ...cluster })),
      nearestCascade: this.state.nearestCascade ? { ...this.state.nearestCascade } : null,
      recentEvents: this.state.recentEvents.map((event) => ({ ...event }))
    };
  }

  private rebuildState(
    levels: LiquidationHeatmapLevel[],
    midPrices: Record<string, number | null>,
    observedAt: ISO8601
  ): LiquidationHeatmapState {
    const clusters = levels
      .filter((level) => level.estimatedNotionalUsd > 0)
      .map((level): LiquidationCascadeCluster => {
        const mid = midPrices[level.instrumentCode] ?? midPrices[this.instrumentCode] ?? null;
        const distance =
          mid && mid > 0 ? Math.abs(level.centerPrice - mid) / mid : null;
        return {
          ...level,
          clusterId: `cascade:${level.instrumentCode}:${level.side}:${level.priceStart}`,
          distanceFromMidPct: distance === null ? null : roundMetric(distance, 6),
          distanceFromMidBps: distance === null ? null : roundMetric(distance * 10_000, 2),
          forcedFlowSide:
            level.side === "LONG" ? "SELL" : level.side === "SHORT" ? "BUY" : "UNKNOWN",
          isCascadeRisk:
            level.estimatedNotionalUsd >= this.clusterThresholdUsd &&
            (distance === null || distance <= this.cascadeDistancePct)
        };
      })
      .sort((left, right) => right.estimatedNotionalUsd - left.estimatedNotionalUsd)
      .slice(0, MAX_LEVELS);

    return {
      schemaVersion: "liquidation-heatmap.v1",
      instrumentCode: this.instrumentCode,
      source_exchange: this.sourceExchange,
      binSize: this.binSize,
      clusterThresholdUsd: this.clusterThresholdUsd,
      cascadeDistancePct: this.cascadeDistancePct,
      levels: levels
        .sort((left, right) => right.estimatedNotionalUsd - left.estimatedNotionalUsd)
        .slice(0, MAX_LEVELS),
      clusters,
      nearestCascade: nearestCluster(clusters, this.instrumentCode, midPrices[this.instrumentCode] ?? null),
      recentEvents: this.state.recentEvents,
      totalEstimatedNotionalUsd: roundMetric(
        levels.reduce((sum, level) => sum + level.estimatedNotionalUsd, 0),
        2
      ),
      sampledWalletCount: 0,
      lastSampleAt: null,
      updatedAt: observedAt
    };
  }
}

export function defaultLiquidationHeatmapState(
  instrumentCode = "btc-usd",
  sourceExchange = "hyperliquid",
  binSize = DEFAULT_BIN_SIZE,
  clusterThresholdUsd = DEFAULT_CLUSTER_THRESHOLD_USD,
  cascadeDistancePct = DEFAULT_CASCADE_DISTANCE_PCT
): LiquidationHeatmapState {
  const now = new Date().toISOString();
  return {
    schemaVersion: "liquidation-heatmap.v1",
    instrumentCode,
    source_exchange: sourceExchange,
    binSize,
    clusterThresholdUsd,
    cascadeDistancePct,
    levels: [],
    clusters: [],
    nearestCascade: null,
    recentEvents: [],
    totalEstimatedNotionalUsd: 0,
    sampledWalletCount: 0,
    lastSampleAt: null,
    updatedAt: now
  };
}

function parseLiquidationEvent(
  raw: unknown,
  context: LiquidationEventContext
): LiquidationEventRecord | null {
  const root = isRecord(raw) ? raw : null;
  const data = isRecord(root?.data) ? root.data : root;
  const liquidation =
    isRecord(data?.liquidation)
      ? data.liquidation
      : isRecord(data?.delta) && data.delta.type === "liquidation"
        ? data.delta
        : isRecord(data) && data.type === "liquidation"
          ? data
          : null;

  if (!liquidation) {
    return null;
  }

  const position = Array.isArray(liquidation.liquidatedPositions)
    ? liquidation.liquidatedPositions.find(isRecord) ?? null
    : null;
  const coin = stringField(position, ["coin"]) ?? stringField(liquidation, ["coin"]);
  const side = sideFromSignedSize(numericField(position, ["szi"]));
  const markPx = numericField(liquidation, ["markPx", "price", "px"]) ?? context.midPrice ?? null;
  const notional =
    numericField(liquidation, ["liquidated_ntl_pos", "notionalUsd", "notional", "accountValue"]) ??
    (position && markPx !== null
      ? Math.abs(numericField(position, ["szi"]) ?? 0) * markPx
      : null);

  return {
    eventId: `liq:event:${stringField(liquidation, ["lid", "hash"]) ?? crypto.randomUUID()}`,
    instrumentCode: coin ? `${coin.toLowerCase()}-usd` : context.instrumentCode ?? null,
    side,
    notionalUsd: notional === null ? null : roundMetric(Math.abs(notional), 2),
    price: markPx === null ? null : roundPrice(markPx),
    liquidatedUser:
      stringField(liquidation, ["liquidated_user", "liquidatedUser"]) ?? null,
    source: isRecord(data?.delta) ? "LEDGER_EVENT" : "USER_EVENT",
    observedAt: context.observedAt
  };
}

function mergeLevels(
  levels: LiquidationHeatmapLevel[],
  binSize: number,
  observedAt: ISO8601
): LiquidationHeatmapLevel[] {
  const merged = new Map<string, LiquidationHeatmapLevel>();

  for (const level of sanitizeLevels(levels)) {
    const start = bucketStart(level.centerPrice, binSize);
    const key = `${level.instrumentCode}:${level.source_exchange}:${level.side}:${start}`;
    const previous = merged.get(key);

    if (!previous) {
      merged.set(key, {
        ...level,
        levelId: `liq:${level.instrumentCode}:${level.side}:${start}`,
        priceStart: roundPrice(start),
        priceEnd: roundPrice(start + binSize),
        centerPrice: roundPrice(start + binSize / 2),
        updatedAt: observedAt
      });
      continue;
    }

    previous.estimatedNotionalUsd = roundMetric(
      previous.estimatedNotionalUsd + level.estimatedNotionalUsd,
      2
    );
    previous.estimatedBaseSize = roundMetric(
      previous.estimatedBaseSize + level.estimatedBaseSize,
      8
    );
    previous.walletCount += level.walletCount;
    previous.eventCount += level.eventCount;
    previous.confidence = roundMetric(Math.max(previous.confidence, level.confidence), 4);
    previous.updatedAt = observedAt;
  }

  return [...merged.values()];
}

function nearestCluster(
  clusters: LiquidationCascadeCluster[],
  instrumentCode: string,
  midPrice: number | null
): LiquidationCascadeCluster | null {
  const candidates = clusters.filter(
    (cluster) => cluster.instrumentCode === instrumentCode && cluster.estimatedNotionalUsd > 0
  );

  if (candidates.length === 0) {
    return null;
  }

  if (!midPrice || midPrice <= 0) {
    return candidates[0] ?? null;
  }

  return [...candidates].sort(
    (left, right) =>
      Math.abs(left.centerPrice - midPrice) - Math.abs(right.centerPrice - midPrice)
  )[0] ?? null;
}

function sanitizeLevels(value: unknown): LiquidationHeatmapLevel[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }

    const centerPrice = numericField(item, ["centerPrice"]);
    const notional = numericField(item, ["estimatedNotionalUsd"]);
    if (centerPrice === null || notional === null || centerPrice <= 0 || notional <= 0) {
      return [];
    }

    const priceStart = numericField(item, ["priceStart"]) ?? centerPrice;
    const priceEnd = numericField(item, ["priceEnd"]) ?? centerPrice;
    return [{
      levelId: stringField(item, ["levelId"]) ?? crypto.randomUUID(),
      instrumentCode: (stringField(item, ["instrumentCode"]) ?? "btc-usd").toLowerCase(),
      source_exchange: normalizeSourceExchange(stringField(item, ["source_exchange"])),
      side: normalizeLiquidationSide(stringField(item, ["side"])),
      priceStart,
      priceEnd,
      centerPrice,
      estimatedNotionalUsd: notional,
      estimatedBaseSize: numericField(item, ["estimatedBaseSize"]) ?? 0,
      walletCount: Math.max(0, Math.floor(numericField(item, ["walletCount"]) ?? 0)),
      eventCount: Math.max(0, Math.floor(numericField(item, ["eventCount"]) ?? 0)),
      confidence: clamp(numericField(item, ["confidence"]) ?? 0.5, 0, 1),
      source:
        item.source === "USER_EVENT" || item.source === "SYNTHETIC"
          ? item.source
          : "CLEARINGHOUSE_STATE",
      updatedAt: stringField(item, ["updatedAt"]) ?? new Date().toISOString()
    }];
  });
}

function eventBackedLevels(levels: LiquidationHeatmapLevel[]): LiquidationHeatmapLevel[] {
  return levels.filter((level) => level.source !== "CLEARINGHOUSE_STATE");
}

function eventBackedClusters(
  clusters: LiquidationCascadeCluster[]
): LiquidationCascadeCluster[] {
  return clusters.filter((cluster) => cluster.source !== "CLEARINGHOUSE_STATE");
}

function eventBackedCluster(
  cluster: LiquidationCascadeCluster
): LiquidationCascadeCluster | null {
  return cluster.source === "CLEARINGHOUSE_STATE" ? null : cluster;
}

function sanitizeClusters(value: unknown): LiquidationCascadeCluster[] {
  return sanitizeLevels(value).map((level) => sanitizeCluster(level));
}

function sanitizeCluster(value: LiquidationHeatmapLevel | LiquidationCascadeCluster): LiquidationCascadeCluster {
  const asCluster = value as LiquidationCascadeCluster;
  return {
    ...value,
    clusterId: asCluster.clusterId ?? `cascade:${value.levelId}`,
    distanceFromMidPct:
      typeof asCluster.distanceFromMidPct === "number" ? asCluster.distanceFromMidPct : null,
    distanceFromMidBps:
      typeof asCluster.distanceFromMidBps === "number" ? asCluster.distanceFromMidBps : null,
    forcedFlowSide:
      asCluster.forcedFlowSide === "BUY" || asCluster.forcedFlowSide === "SELL"
        ? asCluster.forcedFlowSide
        : value.side === "LONG"
          ? "SELL"
          : value.side === "SHORT"
            ? "BUY"
            : "UNKNOWN",
    isCascadeRisk: Boolean(asCluster.isCascadeRisk)
  };
}

function sanitizeEvents(value: unknown): LiquidationEventRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }

    return [{
      eventId: stringField(item, ["eventId"]) ?? crypto.randomUUID(),
      instrumentCode: stringField(item, ["instrumentCode"]),
      side: normalizeLiquidationSide(stringField(item, ["side"])),
      notionalUsd: numericField(item, ["notionalUsd"]),
      price: numericField(item, ["price"]),
      liquidatedUser: stringField(item, ["liquidatedUser"]),
      source:
        item.source === "USER_EVENT" || item.source === "LEDGER_EVENT"
          ? item.source
          : "UNKNOWN",
      observedAt: stringField(item, ["observedAt"]) ?? new Date().toISOString()
    }];
  });
}

function sideFromSignedSize(size: number | null): LiquidationSide {
  if (size === null || size === 0) {
    return "UNKNOWN";
  }
  return size > 0 ? "LONG" : "SHORT";
}

function normalizeLiquidationSide(value: unknown): LiquidationSide {
  const normalized = String(value ?? "").toUpperCase();
  return normalized === "LONG" || normalized === "SHORT" ? normalized : "UNKNOWN";
}

function stringField(value: unknown, paths: string[]): string | null {
  for (const path of paths) {
    const item = readPath(value, path);
    if (typeof item === "string" && item.trim() !== "") {
      return item.trim();
    }
    if (typeof item === "number" && Number.isFinite(item)) {
      return String(item);
    }
  }
  return null;
}

function numericField(value: unknown, paths: string[]): number | null {
  for (const path of paths) {
    const item = readPath(value, path);
    const parsed = Number(item);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function readPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (!isRecord(current)) {
      return undefined;
    }
    return current[segment];
  }, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function bucketStart(price: number, binSize: number): number {
  return Math.floor(price / binSize) * binSize;
}

function positiveNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeSourceExchange(value: unknown): string {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim().toLowerCase()
    : "hyperliquid";
}

function roundPrice(value: number): number {
  return roundMetric(value, 8);
}

function roundMetric(value: number, decimals = 8): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
