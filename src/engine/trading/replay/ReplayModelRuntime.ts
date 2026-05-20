import { roundCrypto, roundMetric } from "../book/SortedBookSide";
import type { ReplayOptions, ReplayScenario } from "../routes/ReplayAdminRoutes";
import type {
  AgentName,
  MarketTick,
  ReplayResult,
  SentimentState,
  TradeIntent
} from "../../../types";

export function applyReplayScenarioToTick(
  tick: MarketTick,
  scenario: ReplayScenario,
  index: number,
  total: number
): MarketTick {
  if (scenario === "BASELINE" || tick.price <= 0 || total <= 0) {
    return tick;
  }

  const progress = index / Math.max(1, total - 1);
  let priceMultiplier = 1;
  let sizeMultiplier = 1;

  if (scenario === "FLASH_CRASH" && progress > 0.35 && progress < 0.55) {
    const crashProgress = (progress - 0.35) / 0.2;
    priceMultiplier = 1 - 0.08 * Math.sin(Math.PI * crashProgress);
    sizeMultiplier = 3;
  } else if (scenario === "DELEVERAGING_2022") {
    priceMultiplier = 1 - 0.18 * progress;
    sizeMultiplier = 1.4 + progress;
  } else if (scenario === "LATENCY_SHOCK") {
    priceMultiplier = 1 + Math.sin(progress * Math.PI * 12) * 0.0025;
    sizeMultiplier = 1.15;
  }

  return {
    ...tick,
    price: roundCrypto(tick.price * priceMultiplier),
    size: roundCrypto(tick.size * sizeMultiplier),
    raw: {
      ...(tick.raw ?? {}),
      replayScenario: scenario
    }
  };
}

export function modelReplayIntentTrade(
  intent: TradeIntent | null,
  tick: MarketTick,
  ticks: MarketTick[],
  index: number,
  options: ReplayOptions,
  regime: ReplayResult["shadowTrades"][number]["regime"]
): ReplayResult["shadowTrades"][number] | null {
  if (!intent) {
    return null;
  }

  const size = intent.approvedSize ?? intent.requestedSize;
  const referencePrice = intent.expectedPrice > 0 ? intent.expectedPrice : tick.price;
  if (size <= 0 || referencePrice <= 0) {
    return null;
  }

  const exitTick = findReplayExitTick(ticks, intent.instrumentCode, index, options.exitAfterTicks);
  if (!exitTick || exitTick.price <= 0) {
    return null;
  }

  const latencyPenaltyBps =
    options.scenario === "LATENCY_SHOCK"
      ? Math.max(options.latencyMs * 0.02, 2)
      : options.latencyMs * 0.005;
  const effectiveSlippageBps = options.slippageBps + latencyPenaltyBps;
  const entrySlippage = effectiveSlippageBps / 10_000;
  const entryPrice =
    intent.action === "BUY"
      ? referencePrice * (1 + entrySlippage)
      : referencePrice * (1 - entrySlippage);
  const exitPrice = exitTick.price;
  const grossPnl =
    intent.action === "BUY" ? (exitPrice - entryPrice) * size : (entryPrice - exitPrice) * size;
  const fees = ((entryPrice + exitPrice) * size * options.feeBps) / 10_000;

  return {
    tradeId: `replay:${intent.intentId}`,
    instrumentCode: intent.instrumentCode,
    side: intent.action,
    entryPrice: roundCrypto(entryPrice),
    exitPrice: roundCrypto(exitPrice),
    size: roundCrypto(size),
    theoreticalPnl: roundMetric(grossPnl - fees, 8),
    fees: roundMetric(fees, 8),
    slippageBps: roundMetric(effectiveSlippageBps, 4),
    driver: inferIntentDriver(intent),
    regime: regime ?? "UNKNOWN",
    openedAt: tick.receivedAt,
    closedAt: exitTick.receivedAt
  };
}

export function findReplayExitTick(
  ticks: MarketTick[],
  instrumentCode: string,
  index: number,
  exitAfterTicks: number
): MarketTick | null {
  let seen = 0;
  for (let cursor = index + 1; cursor < ticks.length; cursor += 1) {
    const candidate = ticks[cursor];
    if (candidate.instrumentCode !== instrumentCode) {
      continue;
    }
    seen += 1;
    if (seen >= exitAfterTicks) {
      return candidate;
    }
  }

  for (let cursor = ticks.length - 1; cursor > index; cursor -= 1) {
    if (ticks[cursor].instrumentCode === instrumentCode) {
      return ticks[cursor];
    }
  }

  return null;
}

export function inferIntentDriver(intent: TradeIntent): AgentName | "UNATTRIBUTED" {
  const text = intent.rationale.toUpperCase();
  if (text.includes("PROFILER") || text.includes("VPIN")) {
    return "PROFILER";
  }
  if (text.includes("ORACLE") || text.includes("REGIME")) {
    return "ORACLE";
  }
  if (text.includes("SENTIMENT")) {
    return "SENTIMENT";
  }
  if (text.includes("MOLTWORKER")) {
    return "MOLTWORKER";
  }
  return "CROUPIER";
}

export function buildReplayAttribution(
  trades: ReplayResult["shadowTrades"]
): NonNullable<ReplayResult["attribution"]> {
  return {
    byAgent: bucketReplayTrades(trades, (trade) => trade.driver ?? "UNATTRIBUTED"),
    byAsset: bucketReplayTrades(trades, (trade) => trade.instrumentCode),
    byRegime: bucketReplayTrades(trades, (trade) => trade.regime ?? "UNKNOWN")
  };
}

export function bucketReplayTrades(
  trades: ReplayResult["shadowTrades"],
  keyFn: (trade: ReplayResult["shadowTrades"][number]) => string
): NonNullable<ReplayResult["attribution"]>["byAgent"] {
  const buckets = new Map<string, ReplayResult["shadowTrades"]>();
  for (const trade of trades) {
    const key = keyFn(trade);
    const bucket = buckets.get(key) ?? [];
    bucket.push(trade);
    buckets.set(key, bucket);
  }

  return [...buckets.entries()].map(([key, bucket]) => {
    const pnl = bucket.map((trade) => trade.theoreticalPnl);
    const grossProfit = pnl.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
    const grossLoss = Math.abs(
      pnl.filter((value) => value < 0).reduce((sum, value) => sum + value, 0)
    );
    return {
      key,
      tradeCount: bucket.length,
      pnl: roundMetric(
        pnl.reduce((sum, value) => sum + value, 0),
        8
      ),
      grossProfit: roundMetric(grossProfit, 8),
      grossLoss: roundMetric(grossLoss, 8),
      winRate: calculateWinRate(bucket),
      sharpe: calculateReplaySharpe(pnl)
    };
  });
}

export function buildReplayEquityCurve(
  initialBankroll: number,
  trades: ReplayResult["shadowTrades"]
): number[] {
  const curve = [initialBankroll];
  let equity = initialBankroll;
  for (const trade of trades) {
    equity += trade.theoreticalPnl;
    curve.push(equity);
  }
  return curve;
}

export function calculateMaxDrawdown(equityCurve: number[]): number {
  let peak = equityCurve[0] ?? 0;
  let maxDrawdown = 0;
  for (const equity of equityCurve) {
    peak = Math.max(peak, equity);
    if (peak > 0) {
      maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
    }
  }
  return roundMetric(maxDrawdown, 8);
}

export function calculateReplaySharpe(pnls: number[]): number | null {
  if (pnls.length < 2) {
    return null;
  }
  const mean = pnls.reduce((sum, pnl) => sum + pnl, 0) / pnls.length;
  const variance = pnls.reduce((sum, pnl) => sum + (pnl - mean) ** 2, 0) / (pnls.length - 1);
  const sigma = Math.sqrt(variance);
  return sigma > 0 ? roundMetric((mean / sigma) * Math.sqrt(pnls.length), 6) : null;
}

export function calculateWinRate(trades: ReplayResult["shadowTrades"]): number | null {
  return trades.length > 0
    ? roundMetric(trades.filter((trade) => trade.theoreticalPnl > 0).length / trades.length, 6)
    : null;
}

export function buildStressSummary(
  trades: ReplayResult["shadowTrades"],
  generatedIntentCount: number
): ReplayResult["stressResults"] {
  const equity = buildReplayEquityCurve(0, trades);
  return [
    {
      scenario: "BASELINE",
      pnl: roundMetric(
        trades.reduce((sum, trade) => sum + trade.theoreticalPnl, 0),
        8
      ),
      maxDrawdown: calculateMaxDrawdown(equity),
      generatedIntentCount,
      simulatedTradeCount: trades.length
    }
  ];
}

export function buildReplayWalkForward(
  trades: ReplayResult["shadowTrades"],
  segments: number
): NonNullable<ReplayResult["walkForward"]> {
  if (trades.length === 0) {
    return [];
  }

  const safeSegments = Math.min(segments, trades.length);
  const chunkSize = Math.ceil(trades.length / safeSegments);
  const rows: NonNullable<ReplayResult["walkForward"]> = [];
  for (let segment = 0; segment < safeSegments; segment += 1) {
    const bucket = trades.slice(segment * chunkSize, (segment + 1) * chunkSize);
    if (bucket.length === 0) {
      continue;
    }
    const pnl = bucket.reduce((sum, trade) => sum + trade.theoreticalPnl, 0);
    rows.push({
      segment: segment + 1,
      dateFrom: bucket[0].openedAt,
      dateTo: bucket.at(-1)?.closedAt ?? bucket.at(-1)?.openedAt ?? null,
      pnl: roundMetric(pnl, 8),
      sharpe: calculateReplaySharpe(bucket.map((trade) => trade.theoreticalPnl)),
      maxDrawdown: calculateMaxDrawdown(buildReplayEquityCurve(0, bucket)),
      tradeCount: bucket.length
    });
  }
  return rows;
}

export function buildReplayAblation(
  trades: ReplayResult["shadowTrades"],
  sentiment: SentimentState
): ReplayResult["ablation"] {
  const sentimentTrades = trades.filter((trade) => trade.driver === "SENTIMENT");
  const sentimentEnabledPnl = trades.reduce((sum, trade) => sum + trade.theoreticalPnl, 0);
  const sentimentContribution = sentimentTrades.reduce(
    (sum, trade) => sum + trade.theoreticalPnl,
    0
  );
  const estimatedAiCostUsd = sentiment.estimatedCostUsd ?? 0;
  const sentimentDisabledPnl = sentimentEnabledPnl - sentimentContribution;
  return {
    sentimentEnabledPnl: roundMetric(sentimentEnabledPnl, 8),
    sentimentDisabledPnl: roundMetric(sentimentDisabledPnl, 8),
    deltaPnl: roundMetric(sentimentContribution, 8),
    estimatedAiCostUsd,
    netEdgeAfterCosts: roundMetric(sentimentContribution - estimatedAiCostUsd, 8)
  };
}
