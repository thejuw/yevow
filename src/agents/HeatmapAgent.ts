import type {
  ISO8601,
  JsonRecord,
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
  infoUrl?: string;
  wallets?: string[];
  coin?: string;
  instrumentCode?: string;
  sourceExchange?: string;
  binSize?: number;
  clusterThresholdUsd?: number;
  cascadeDistancePct?: number;
  maxWallets?: number;
}

export interface HeatmapSampleContext {
  midPrices: Record<string, number | null>;
  observedAt: ISO8601;
}

export interface LiquidationEventContext {
  instrumentCode?: string | null;
  sourceExchange?: string | null;
  midPrice?: number | null;
  observedAt: ISO8601;
}

export class HeatmapAgent {
  private readonly infoUrl: string;
  private readonly wallets: string[];
  private readonly coin: string;
  private readonly instrumentCode: string;
  private readonly sourceExchange: string;
  private readonly binSize: number;
  private readonly clusterThresholdUsd: number;
  private readonly cascadeDistancePct: number;
  private readonly maxWallets: number;
  private state: LiquidationHeatmapState;

  constructor(config: HeatmapAgentConfig = {}) {
    this.infoUrl = config.infoUrl ?? "https://api.hyperliquid.xyz/info";
    this.wallets = sanitizeWallets(config.wallets ?? []);
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
    this.maxWallets = Math.max(0, Math.floor(positiveNumber(config.maxWallets, 10)));
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
      levels: sanitizeLevels(persisted.levels).slice(0, MAX_LEVELS),
      clusters: sanitizeClusters(persisted.clusters).slice(0, MAX_LEVELS),
      nearestCascade: persisted.nearestCascade
        ? sanitizeCluster(persisted.nearestCascade)
        : null,
      recentEvents: sanitizeEvents(persisted.recentEvents).slice(-MAX_RECENT_EVENTS)
    };
  }

  async sampleKnownWallets(context: HeatmapSampleContext): Promise<LiquidationHeatmapState> {
    const wallets = this.wallets.slice(0, this.maxWallets);
    const levels: LiquidationHeatmapLevel[] = [];
    const sampledAt = context.observedAt;

    for (const wallet of wallets) {
      try {
        const state = await this.fetchClearinghouseState(wallet);
        levels.push(...this.levelsFromClearinghouseState(state, wallet, context));
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "LIQUIDATION_HEATMAP_SAMPLE_FAILED",
            wallet,
            message: error instanceof Error ? error.message : "UNKNOWN_ERROR"
          })
        );
      }
    }

    const merged = mergeLevels(
      [...this.state.levels.filter((level) => level.source === "USER_EVENT"), ...levels],
      this.binSize,
      sampledAt
    );
    const next = this.rebuildState(merged, context.midPrices, sampledAt, wallets.length);
    this.state = next;
    return this.snapshot();
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
        context.observedAt,
        this.state.sampledWalletCount
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

  private async fetchClearinghouseState(wallet: string): Promise<Record<string, unknown>> {
    const response = await fetch(this.infoUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify({ type: "clearinghouseState", user: wallet })
    });

    if (!response.ok) {
      throw new Error(`HL_INFO_${response.status}`);
    }

    const body = await response.json<unknown>();
    return isRecord(body) ? body : {};
  }

  private levelsFromClearinghouseState(
    state: Record<string, unknown>,
    wallet: string,
    context: HeatmapSampleContext
  ): LiquidationHeatmapLevel[] {
    const positions = Array.isArray(state.assetPositions) ? state.assetPositions : [];
    const observedAt = context.observedAt;
    const levels: LiquidationHeatmapLevel[] = [];

    for (const item of positions) {
      const position = isRecord(item) && isRecord(item.position) ? item.position : null;

      if (!position) {
        continue;
      }

      const coin = stringField(position, ["coin"])?.toUpperCase();
      if (coin && coin !== this.coin) {
        continue;
      }

      const szi = numericField(position, ["szi", "size", "positionSize"]);
      if (szi === null || szi === 0) {
        continue;
      }

      const side: LiquidationSide = szi > 0 ? "LONG" : "SHORT";
      const instrumentCode = coin ? `${coin.toLowerCase()}-usd` : this.instrumentCode;
      const midPrice = context.midPrices[instrumentCode] ?? context.midPrices[this.instrumentCode] ?? null;
      const markPrice =
        numericField(position, ["markPx", "markPrice"]) ?? midPrice ?? numericField(position, ["entryPx", "entryPrice"]);
      const liquidationPrice = liquidationPriceFromPosition(position, side);

      if (liquidationPrice === null || liquidationPrice <= 0 || markPrice === null || markPrice <= 0) {
        continue;
      }

      const notional =
        Math.abs(numericField(position, ["positionValue", "notional", "marginUsed"]) ?? 0) ||
        Math.abs(szi) * markPrice;
      const start = bucketStart(liquidationPrice, this.binSize);

      levels.push({
        levelId: `liq:state:${instrumentCode}:${side}:${start}`,
        instrumentCode,
        source_exchange: this.sourceExchange,
        side,
        priceStart: roundPrice(start),
        priceEnd: roundPrice(start + this.binSize),
        centerPrice: roundPrice(start + this.binSize / 2),
        estimatedNotionalUsd: roundMetric(notional, 2),
        estimatedBaseSize: roundMetric(Math.abs(szi), 8),
        walletCount: 1,
        eventCount: 0,
        confidence: hasNativeLiquidationPrice(position) ? 0.9 : 0.35,
        source: "CLEARINGHOUSE_STATE",
        updatedAt: observedAt
      });

      void wallet;
    }

    return levels;
  }

  private rebuildState(
    levels: LiquidationHeatmapLevel[],
    midPrices: Record<string, number | null>,
    observedAt: ISO8601,
    sampledWalletCount: number
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
      sampledWalletCount,
      lastSampleAt: observedAt,
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

export function parseLiquidationWallets(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      return sanitizeWallets(parsed.map(String));
    }
  } catch {
    // Fall through to CSV parsing.
  }

  return sanitizeWallets(trimmed.split(/[,\s]+/));
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

function liquidationPriceFromPosition(
  position: Record<string, unknown>,
  side: LiquidationSide
): number | null {
  const native = numericField(position, [
    "liquidationPx",
    "liquidationPrice",
    "liqPx",
    "liqPrice"
  ]);

  if (native !== null && native > 0) {
    return native;
  }

  const entry = numericField(position, ["entryPx", "entryPrice"]);
  const leverage = numericField(position, ["leverage.value", "leverage", "maxLeverage"]);

  if (entry === null || leverage === null || leverage <= 0) {
    return null;
  }

  const maintenanceHaircut = 0.5 / leverage;
  return side === "LONG"
    ? roundPrice(entry * (1 - maintenanceHaircut))
    : roundPrice(entry * (1 + maintenanceHaircut));
}

function hasNativeLiquidationPrice(position: Record<string, unknown>): boolean {
  return numericField(position, [
    "liquidationPx",
    "liquidationPrice",
    "liqPx",
    "liqPrice"
  ]) !== null;
}

function sanitizeWallets(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()))].filter(
    (value) => /^0x[a-f0-9]{40}$/.test(value)
  );
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
