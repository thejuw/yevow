import { priceKey, roundCrypto, roundMetric } from "./SortedBookSide";
import type {
  DomAnalysisSnapshot,
  DomHeatmapCell,
  LiquidityWall,
  MarketTick,
  OrderBookSide,
  PriceLevel
} from "../../../types";

interface DomBinAccumulator {
  side: OrderBookSide;
  priceStart: number;
  priceEnd: number;
  centerPrice: number;
  volume: number;
  levelCount: number;
}

export function aggregateDomBins(
  bidLevels: PriceLevel[],
  askLevels: PriceLevel[],
  binSize: number
): DomBinAccumulator[] {
  const bins = new Map<string, DomBinAccumulator>();

  const appendLevel = (level: PriceLevel, side: OrderBookSide) => {
    if (!Number.isFinite(level.price) || !Number.isFinite(level.size) || level.size <= 0) {
      return;
    }

    const priceStart = roundCrypto(Math.floor(level.price / binSize) * binSize);
    const priceEnd = roundCrypto(priceStart + binSize);
    const key = `${side}:${priceKey(priceStart)}`;
    const existing = bins.get(key);

    if (existing) {
      existing.volume = roundCrypto(existing.volume + level.size);
      existing.levelCount += 1;
      return;
    }

    bins.set(key, {
      side,
      priceStart,
      priceEnd,
      centerPrice: roundCrypto(priceStart + binSize / 2),
      volume: roundCrypto(level.size),
      levelCount: 1
    });
  };

  for (const level of bidLevels) {
    appendLevel(level, "bid");
  }

  for (const level of askLevels) {
    appendLevel(level, "ask");
  }

  return [...bins.values()].sort((left, right) => {
    if (left.side !== right.side) {
      return left.side === "bid" ? -1 : 1;
    }

    return left.side === "bid"
      ? right.priceStart - left.priceStart
      : left.priceStart - right.priceStart;
  });
}

export function volumeStats(volumes: number[]): { mean: number; sigma: number } {
  if (volumes.length === 0) {
    return { mean: 0, sigma: 0 };
  }

  const mean = volumes.reduce((sum, volume) => sum + volume, 0) / volumes.length;
  const variance = volumes.reduce((sum, volume) => sum + (volume - mean) ** 2, 0) / volumes.length;

  return {
    mean: roundCrypto(mean),
    sigma: roundCrypto(Math.sqrt(variance))
  };
}

export function isLiquidityWall(volume: number, mean: number, sigma: number): boolean {
  return sigma > 0 && volume > mean + 3 * sigma;
}

export function toLiquidityWall(
  bin: DomBinAccumulator,
  instrumentCode: string,
  exchangeCode: string,
  sequence: number,
  midPrice: number,
  meanVolume: number,
  sigmaVolume: number,
  previous: LiquidityWall | undefined,
  observedAt: string
): LiquidityWall {
  const zScore = sigmaVolume > 0 ? (bin.volume - meanVolume) / sigmaVolume : 0;

  return {
    wallId: wallIdForBin(instrumentCode, bin),
    instrumentCode,
    exchangeCode,
    side: bin.side,
    priceStart: bin.priceStart,
    priceEnd: bin.priceEnd,
    centerPrice: bin.centerPrice,
    volume: bin.volume,
    meanVolume,
    sigmaVolume,
    zScore: roundMetric(zScore, 4),
    levelCount: bin.levelCount,
    status: "ACTIVE",
    firstSeenAt: previous?.firstSeenAt ?? observedAt,
    lastSeenAt: observedAt,
    lastSequence: sequence,
    distanceFromMidBps: distanceBps(bin.centerPrice, midPrice),
    spoofingSuspected: false
  };
}

export function wallIdForBin(instrumentCode: string, bin: DomBinAccumulator): string {
  return `dom:${instrumentCode}:${bin.side}:${priceKey(bin.priceStart)}`;
}

export function latestActiveWalls(
  history: LiquidityWall[],
  instrumentCode: string
): Map<string, LiquidityWall> {
  const latest = new Map<string, LiquidityWall>();

  for (const wall of history) {
    if (wall.instrumentCode === instrumentCode) {
      latest.set(wall.wallId, wall);
    }
  }

  return new Map([...latest.entries()].filter(([, wall]) => wall.status === "ACTIVE"));
}

export function classifyMissingWalls(
  previousActiveWalls: Map<string, LiquidityWall>,
  currentWallIds: Set<string>,
  tick: MarketTick | undefined,
  observedAt: string,
  binSize: number,
  spoofProximityBps: number,
  midPrice: number
): LiquidityWall[] {
  const transitions: LiquidityWall[] = [];

  for (const wall of previousActiveWalls.values()) {
    if (currentWallIds.has(wall.wallId)) {
      continue;
    }

    const filled = tick ? wasWallFilled(wall, tick) : false;
    const closeToTouch = tick
      ? Math.abs(tick.price - wall.centerPrice) <=
        Math.max(binSize * 2, tick.price * (spoofProximityBps / 10_000))
      : false;

    transitions.push({
      ...wall,
      status: filled ? "FILLED" : "PULLED",
      lastSeenAt: observedAt,
      lastSequence: tick?.sequence ?? wall.lastSequence,
      distanceFromMidBps: distanceBps(wall.centerPrice, midPrice),
      spoofingSuspected: !filled && closeToTouch
    });
  }

  return transitions;
}

export function wasWallFilled(wall: LiquidityWall, tick: MarketTick): boolean {
  return (
    (wall.side === "ask" && tick.side === "buy" && tick.price >= wall.priceStart) ||
    (wall.side === "bid" && tick.side === "sell" && tick.price <= wall.priceEnd)
  );
}

export function domHeatmapCell(
  bin: DomBinAccumulator,
  meanVolume: number,
  sigmaVolume: number
): DomHeatmapCell {
  const zScore = sigmaVolume > 0 ? (bin.volume - meanVolume) / sigmaVolume : 0;

  return [
    bin.side === "bid" ? 0 : 1,
    bin.priceStart,
    bin.priceEnd,
    bin.volume,
    bin.levelCount,
    roundMetric(zScore, 4)
  ];
}

export function emptyDomSnapshot(
  instrumentCode: string,
  exchangeCode: string | null,
  sequence: number | null,
  midPrice: number | null,
  scanRangePct: number,
  binSize: number,
  history: LiquidityWall[],
  observedAt: string
): DomAnalysisSnapshot {
  return {
    schemaVersion: "dom.analysis.v1",
    instrumentCode,
    exchangeCode,
    sequence,
    midPrice,
    scanRangePct,
    lowerBound: null,
    upperBound: null,
    binSize,
    meanVolume: 0,
    sigmaVolume: 0,
    walls: [],
    pulledWalls: [],
    filledWalls: [],
    heatmap: {
      schemaVersion: "dom.heatmap.v1",
      columns: ["side", "priceStart", "priceEnd", "volume", "levelCount", "zScore"],
      sideEncoding: { bid: 0, ask: 1 },
      cells: []
    },
    history,
    updatedAt: observedAt
  };
}

export function distanceBps(price: number, referencePrice: number): number | null {
  if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
    return null;
  }

  return roundMetric(Math.abs((price - referencePrice) / referencePrice) * 10_000, 4);
}

export function sanitizeWallHistory(value: LiquidityWall[] | undefined): LiquidityWall[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isLiquidityWallRecord);
}

export function isLiquidityWallRecord(value: LiquidityWall): boolean {
  return (
    typeof value?.wallId === "string" &&
    typeof value.instrumentCode === "string" &&
    typeof value.exchangeCode === "string" &&
    (value.side === "bid" || value.side === "ask") &&
    (value.status === "ACTIVE" || value.status === "PULLED" || value.status === "FILLED") &&
    Number.isFinite(value.priceStart) &&
    Number.isFinite(value.priceEnd) &&
    Number.isFinite(value.centerPrice) &&
    Number.isFinite(value.volume)
  );
}
