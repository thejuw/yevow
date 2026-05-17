import type {
  InternalOrderBook,
  InventoryState,
  LeadLagMetrics,
  LiquidationCascadeCluster,
  LiquidationHeatmapState,
  MacroBias,
  OracleState,
  QuoteOrder,
  QuoteSignal,
  SentimentState,
  ToxicityPressureSide,
  ToxicityState,
  TradeDirection,
  TradeIntent
} from "../types";

const DEFAULT_MIN_EV_THRESHOLD = 0;
const DEFAULT_FEE_BPS = 5;
const ADVERSE_SELECTION_CRITICAL_COST = 0.02;
const PRICE_EPSILON = 1e-12;

export interface CroupierConfig {
  minEvThreshold?: number;
  exchangeFeeBps?: number;
  riskAversionFactor?: number;
  minTickChange?: number;
}

export interface CroupierInput {
  engineId: string;
  book: InternalOrderBook;
  oracle: OracleState;
  sentiment: SentimentState;
  toxicityScore: number;
  inventory: InventoryState;
  leadLag: LeadLagMetrics;
  minEvThreshold?: number;
  exchangeFeeBps?: number;
  executionCostBufferBps?: number;
  fundingRateHourly?: number;
  fundingHorizonHours?: number;
  riskAversionFactor?: number;
  fundingBiasThreshold?: number;
  fundingInventoryBias?: number;
  liquidationHeatmap?: LiquidationHeatmapState | null;
  predatoryOrderOffsetBps?: number;
  profilerToxicityState?: ToxicityState;
  profilerPressureSide?: ToxicityPressureSide;
  profilerSpreadMultiplier?: number;
  profilerReservationShiftBps?: number;
  macroBias?: MacroBias;
  observedAt: string;
}

export interface CroupierDecision {
  intent: TradeIntent | null;
  quote: QuoteSignal | null;
  pullAllQuotes: boolean;
  adverseSelectionCost: number;
  minEvThreshold: number;
}

export class CroupierAgent {
  private readonly minEvThreshold: number;
  private readonly exchangeFeeBps: number;
  private readonly riskAversionFactor: number;
  private readonly amm: AMMEngine;

  constructor(config: CroupierConfig = {}) {
    this.minEvThreshold = finiteNumber(config.minEvThreshold, DEFAULT_MIN_EV_THRESHOLD);
    this.exchangeFeeBps = finiteNumber(config.exchangeFeeBps, DEFAULT_FEE_BPS);
    this.riskAversionFactor = finiteNumber(config.riskAversionFactor, 0.01);
    this.amm = new AMMEngine(config.minTickChange ?? 0.00000001, this.riskAversionFactor);
  }

  evaluate(input: CroupierInput): CroupierDecision {
    const adverseSelectionCost = this.calculateInformationPremium(input.toxicityScore);
    const pullAllQuotes = input.profilerToxicityState === "CRITICAL";
    const baseMinEvThreshold = finiteNumber(input.minEvThreshold, this.minEvThreshold);
    const macroThresholdMultiplier = macroBiasThresholdMultiplier(
      input.macroBias,
      preferredDirection(input),
      input.book.instrumentCode
    );
    const minEvThreshold =
      baseMinEvThreshold *
      sentimentMultiplier(input.sentiment, preferredDirection(input)) *
      macroThresholdMultiplier;
    const quote = pullAllQuotes ? null : this.amm.quote(input, adverseSelectionCost);
    const intent = pullAllQuotes
      ? null
      : this.createIntent(
          input,
          minEvThreshold,
          adverseSelectionCost,
          quote?.reservationPrice ?? null
        );

    return {
      intent: intent && intent.expectedValue > intent.minEvThreshold ? intent : null,
      quote,
      pullAllQuotes,
      adverseSelectionCost,
      minEvThreshold
    };
  }

  calculateInformationPremium(vpinScore: number): number {
    return vpinScore >= 1 ? ADVERSE_SELECTION_CRITICAL_COST : 0;
  }

  private createIntent(
    input: CroupierInput,
    minEvThreshold: number,
    adverseSelectionCost: number,
    reservationPrice: number | null
  ): TradeIntent | null {
    const mid = input.book.midPrice;

    if (mid === null || mid <= 0 || !input.oracle.posteriorPdf) {
      return null;
    }

    const direction = preferredDirection(input);

    if (direction === "LONG" && input.inventory.stopBid) {
      return null;
    }

    if (direction === "SHORT" && input.inventory.stopAsk) {
      return null;
    }

    const macroScore = macroBiasDirectionalScore(
      input.macroBias,
      direction,
      input.book.instrumentCode
    );
    const probabilityWin = boundProbability(
      probabilityForDirection(input.oracle, direction, mid) + macroScore * 0.05
    );
    const probabilityLoss = 1 - probabilityWin;
    const profit = mid * input.oracle.profitTargetBps / 10_000;
    const loss = Math.max(profit, mid * Math.max(input.book.spreadBps ?? 1, 1) / 10_000);
    const requestedSize = calculateRequestSize(input, direction);
    const estimatedSlippage = estimateSlippageCost(input.book, direction, requestedSize);
    const exchangeFeeBps = finiteNumber(input.exchangeFeeBps, this.exchangeFeeBps);
    const fees = mid * exchangeFeeBps / 10_000;
    const executionCostBuffer =
      mid * Math.max(0, finiteNumber(input.executionCostBufferBps, 0)) / 10_000;
    const fundingRateHourly = finiteNumber(input.fundingRateHourly, 0);
    const fundingHorizonHours = Math.max(0, finiteNumber(input.fundingHorizonHours, 1));
    const fundingCarryCost = calculateFundingCarryCost(
      mid,
      requestedSize,
      direction,
      fundingRateHourly,
      fundingHorizonHours
    );
    const riskAversionFactor = finiteNumber(input.riskAversionFactor, this.riskAversionFactor);
    const inventoryPenalty =
      Math.abs(input.inventory.current_inventory_delta ?? input.inventory.netDelta) *
      riskAversionFactor;
    const leadLagBoost = input.leadLag.executable ? Math.max(0, input.leadLag.expectedValue ?? 0) : 0;
    const macroBiasEv = mid * 0.0005 * macroScore;
    const executionCosts =
      fees +
      estimatedSlippage +
      adverseSelectionCost * mid +
      executionCostBuffer +
      fundingCarryCost +
      inventoryPenalty;
    const expectedValue =
      probabilityWin * profit - probabilityLoss * loss - executionCosts + leadLagBoost + macroBiasEv;

    return {
      schemaVersion: "trade-intent.v1",
      intentId: crypto.randomUUID(),
      traceId: `${input.engineId}:croupier:${input.book.marketKey}:${input.observedAt}`,
      instrumentCode: input.book.instrumentCode,
      marketKey: input.book.marketKey,
      source_exchange: input.book.source_exchange,
      direction,
      action: direction === "LONG" ? "BUY" : "SELL",
      orderType: "LIMIT",
      postOnly: true,
      timeInForce: "ALO",
      intendedPrice: reservationPrice ?? input.book.midPrice ?? input.book.bestBid ?? input.book.bestAsk ?? 0,
      expectedPrice: reservationPrice ?? input.book.midPrice ?? input.book.bestBid ?? input.book.bestAsk ?? 0,
      requestedSize,
      approvedSize: null,
      probabilityWin,
      probabilityLoss,
      profit,
      loss,
      executionCosts,
      adverseSelectionCost,
      expectedValue,
      minEvThreshold,
      maxSlippageBps: Math.max(5, input.book.spreadBps ?? 5),
      confidence: Math.min(1, Math.max(0, Math.abs(input.book.weightedImbalance ?? 0))),
      rationale:
        `Croupier EV calculation with toxicity, sentiment, AS reservation price, inventory, slippage, funding, lead-lag and macro bias inputs. ` +
        `fundingHourly=${round(fundingRateHourly, 8)} fundingCarry=${round(fundingCarryCost, 8)} ` +
        `reservation=${round(reservationPrice ?? mid, 8)} gamma=${round(riskAversionFactor, 8)} ` +
        `macroBias=${input.macroBias?.direction ?? "NEUTRAL"} score=${round(macroScore, 4)} ` +
        `amVpinState=${input.profilerToxicityState ?? "NORMAL"} ` +
        `spreadMultiplier=${round(Math.max(1, finiteNumber(input.profilerSpreadMultiplier, 1)), 4)} ` +
        `discretePostOnly=true`,
      createdAt: input.observedAt
    };
  }
}

class AMMEngine {
  private lastQuoteMid: number | null = null;

  constructor(
    private readonly minTickChange: number,
    private readonly riskAversionFactor: number
  ) {}

  quote(input: CroupierInput, adverseSelectionCost: number): QuoteSignal | null {
    const mid = input.book.midPrice;

    if (mid === null || mid <= 0) {
      return null;
    }

    if (
      this.lastQuoteMid !== null &&
      Math.abs(mid - this.lastQuoteMid) < this.minTickChange
    ) {
      return null;
    }

    this.lastQuoteMid = mid;
    const variance = input.oracle.volatility ** 2;
    const riskAversionFactor = finiteNumber(
      input.riskAversionFactor,
      this.riskAversionFactor
    );
    const topDepth =
      input.book.bids.slice(0, 5).reduce((sum, level) => sum + level.size, 0) +
      input.book.asks.slice(0, 5).reduce((sum, level) => sum + level.size, 0);
    const arrivalIntensity =
      Math.log1p(topDepth) / Math.max(1, input.book.spreadBps ?? 1);
    const liquidityTightening = 1 / Math.sqrt(1 + arrivalIntensity);
    const fundingTargetDelta = fundingInventoryTargetDelta(input);
    const currentDelta =
      input.inventory.current_inventory_delta ?? input.inventory.netDelta;
    const inventoryDisplacement = currentDelta - fundingTargetDelta;
    const profilerReservationShiftBps = finiteNumber(
      input.profilerReservationShiftBps,
      0
    );
    const pressureShift =
      input.profilerPressureSide === "BUY"
        ? mid * profilerReservationShiftBps / 10_000
        : input.profilerPressureSide === "SELL"
          ? -mid * profilerReservationShiftBps / 10_000
          : 0;
    const reservationPrice =
      mid -
      inventoryDisplacement * riskAversionFactor * variance +
      pressureShift;
    const spreadMultiplier = Math.max(
      1,
      finiteNumber(input.profilerSpreadMultiplier, 1)
    );
    const halfSpread =
      (Math.max(input.book.spread ?? mid * 0.0001, mid * input.oracle.volatility * 0.25) *
        liquidityTightening +
        adverseSelectionCost * mid) *
      spreadMultiplier;
    const rawBid = reservationPrice - halfSpread;
    const rawAsk = reservationPrice + halfSpread;
    const bid = snapGueantDiscretePrice(rawBid, "BID", input);
    const ask = snapGueantDiscretePrice(rawAsk, "ASK", input);
    const quoteSize = calculateQuoteSize(input);
    const liquidationCluster = selectLiquidationCluster(input.liquidationHeatmap, input.book);
    const predatoryOrder = predatoryLiquidationOrder(input, quoteSize, liquidationCluster);
    const suppressBid = suppressBidForToxicity(input);
    const suppressAsk = suppressAskForToxicity(input);
    const boundaryOnly =
      Boolean(predatoryOrder) &&
      Boolean(liquidationCluster?.isCascadeRisk) &&
      input.toxicityScore >= 0.99;
    const orders: QuoteOrder[] = [];

    if (!boundaryOnly && !input.inventory.stopBid && !suppressBid) {
      orders.push({
        clientOrderId: crypto.randomUUID(),
        side: "BID",
        price: bid,
        size: quoteSize.bid,
        postOnly: true,
        strategy: "AMM"
      });
    }

    if (!boundaryOnly && !input.inventory.stopAsk && !suppressAsk) {
      orders.push({
        clientOrderId: crypto.randomUUID(),
        side: "ASK",
        price: ask,
        size: quoteSize.ask,
        postOnly: true,
        strategy: "AMM"
      });
    }

    if (predatoryOrder) {
      orders.push(predatoryOrder);
    }

    if (orders.length === 0) {
      return null;
    }

    return {
      schemaVersion: "quote-signal.v1",
      signalId: crypto.randomUUID(),
      instrumentCode: input.book.instrumentCode,
      marketKey: input.book.marketKey,
      reservationPrice: normalizeTickDecimal(reservationPrice, input.book.tickSize),
      optimalSpread: normalizeTickDecimal(Math.max(0, ask - bid), input.book.tickSize),
      orders,
      createdAt: input.observedAt
    };
  }
}

function suppressBidForToxicity(input: CroupierInput): boolean {
  return input.profilerToxicityState === "TOXIC" && input.profilerPressureSide === "SELL";
}

function suppressAskForToxicity(input: CroupierInput): boolean {
  return input.profilerToxicityState === "TOXIC" && input.profilerPressureSide === "BUY";
}

function preferredDirection(input: CroupierInput): TradeDirection {
  const pdfBullish =
    input.oracle.posteriorPdf?.points
      .filter((point) => point.price >= input.oracle.posteriorPdf!.currentPrice)
      .reduce((sum, point) => sum + point.probability, 0) ?? 0.5;
  const imbalance = input.book.weightedImbalance ?? 0;
  const macroBias = macroBiasDirectionalScore(
    input.macroBias,
    "LONG",
    input.book.instrumentCode
  );
  return pdfBullish + imbalance * 0.15 + macroBias * 0.1 >= 0.5 ? "LONG" : "SHORT";
}

function probabilityForDirection(
  oracle: OracleState,
  direction: TradeDirection,
  currentPrice: number
): number {
  const probabilityAbove =
    oracle.posteriorPdf?.points
      .filter((point) => point.price >= currentPrice)
      .reduce((sum, point) => sum + point.probability, 0) ?? 0.5;
  return direction === "LONG" ? probabilityAbove : 1 - probabilityAbove;
}

function sentimentMultiplier(sentiment: SentimentState, direction: TradeDirection): number {
  if (direction === "LONG" && sentiment.score < 0) {
    return 1 + Math.abs(sentiment.score) * 1.5;
  }

  if (direction === "SHORT" && sentiment.score > 0) {
    return 1 + Math.abs(sentiment.score) * 1.5;
  }

  return 1;
}

function macroBiasDirectionalScore(
  macroBias: MacroBias | undefined,
  direction: TradeDirection,
  instrumentCode: string
): number {
  if (!macroBias || macroBias.direction === "NEUTRAL" || !macroBiasApplies(macroBias, instrumentCode)) {
    return 0;
  }

  const raw =
    macroBias.direction === "BULLISH" || macroBias.direction === "RISK_ON"
      ? 1
      : -1;
  const directional = direction === "LONG" ? raw : -raw;

  return directional * macroBias.intensity * macroBias.confidence;
}

function macroBiasThresholdMultiplier(
  macroBias: MacroBias | undefined,
  direction: TradeDirection,
  instrumentCode: string
): number {
  const score = macroBiasDirectionalScore(macroBias, direction, instrumentCode);

  if (score >= 0) {
    return Math.max(0.75, 1 - score * 0.15);
  }

  return 1 + Math.abs(score) * 0.5;
}

function macroBiasApplies(macroBias: MacroBias, instrumentCode: string): boolean {
  return (
    macroBias.instruments.length === 0 ||
    macroBias.instruments.includes(instrumentCode.toLowerCase())
  );
}

function boundProbability(value: number): number {
  return Math.min(0.999999, Math.max(0.000001, value));
}

function calculateRequestSize(input: CroupierInput, direction: TradeDirection): number {
  const levels = direction === "LONG" ? input.book.asks : input.book.bids;
  const topDepth = levels.slice(0, 5).reduce((sum, level) => sum + level.size, 0);
  const inventoryRoom =
    direction === "LONG"
      ? Math.max(0, input.inventory.maxInventoryUnits - input.inventory.netDelta)
      : Math.max(0, input.inventory.maxInventoryUnits + input.inventory.netDelta);
  const depthBound = topDepth > 0 ? topDepth * 0.05 : 0.00000001;
  return round(Math.max(0.00000001, Math.min(depthBound, inventoryRoom || depthBound)), 8);
}

function calculateQuoteSize(input: CroupierInput): { bid: number; ask: number } {
  const bidDepth = input.book.bids.slice(0, 5).reduce((sum, level) => sum + level.size, 0);
  const askDepth = input.book.asks.slice(0, 5).reduce((sum, level) => sum + level.size, 0);
  const bidRoom = Math.max(0, input.inventory.maxInventoryUnits - input.inventory.netDelta);
  const askRoom = Math.max(0, input.inventory.maxInventoryUnits + input.inventory.netDelta);

  return {
    bid: round(Math.max(0.00000001, Math.min(bidRoom, Math.max(0.00000001, bidDepth * 0.02))), 8),
    ask: round(Math.max(0.00000001, Math.min(askRoom, Math.max(0.00000001, askDepth * 0.02))), 8)
  };
}

function snapGueantDiscretePrice(
  rawPrice: number,
  side: QuoteOrder["side"],
  input: CroupierInput
): number {
  const tickSize = normalizeTickSize(input.book.tickSize);
  const currentDelta = finiteNumber(
    input.inventory.current_inventory_delta,
    input.inventory.netDelta
  );
  const hardCap = Math.max(
    Math.abs(input.inventory.maxInventoryDelta),
    Math.abs(input.inventory.maxInventoryUnits),
    PRICE_EPSILON
  );
  const pressureTicks = Math.min(3, Math.floor(Math.abs(currentDelta) / hardCap * 4));
  const reducesLong = currentDelta > 0 && side === "ASK";
  const reducesShort = currentDelta < 0 && side === "BID";
  const accumulatesLong = currentDelta > 0 && side === "BID";
  const accumulatesShort = currentDelta < 0 && side === "ASK";

  if (side === "BID") {
    const passive = floorToTick(rawPrice, tickSize);
    if (reducesShort) {
      const aggressive = ceilToTick(rawPrice, tickSize);
      return normalizeTickDecimal(
        input.book.bestAsk === null || aggressive < input.book.bestAsk
          ? aggressive
          : passive,
        tickSize
      );
    }

    return normalizeTickDecimal(
      Math.max(tickSize, accumulatesLong ? passive - pressureTicks * tickSize : passive),
      tickSize
    );
  }

  const passive = ceilToTick(rawPrice, tickSize);
  if (reducesLong) {
    const aggressive = floorToTick(rawPrice, tickSize);
    return normalizeTickDecimal(
      input.book.bestBid === null || aggressive > input.book.bestBid
        ? aggressive
        : passive,
      tickSize
    );
  }

  return normalizeTickDecimal(
    Math.max(tickSize, accumulatesShort ? passive + pressureTicks * tickSize : passive),
    tickSize
  );
}

function fundingInventoryTargetDelta(input: CroupierInput): number {
  const fundingRateHourly = finiteNumber(input.fundingRateHourly, 0);
  const threshold = Math.max(0, finiteNumber(input.fundingBiasThreshold, 0.00001));
  const configuredBias = Math.max(0, finiteNumber(input.fundingInventoryBias, 0));

  if (threshold === 0 || Math.abs(fundingRateHourly) < threshold) {
    return 0;
  }

  const maxBias =
    configuredBias > 0
      ? configuredBias
      : Math.max(0, input.inventory.maxInventoryDelta * 0.25);

  if (maxBias <= 0) {
    return 0;
  }

  const scaled = Math.min(1, Math.abs(fundingRateHourly) / Math.max(threshold, 1e-12));

  // Positive funding means longs pay shorts, so the neutral target is nudged short.
  return fundingRateHourly > 0 ? -maxBias * scaled : maxBias * scaled;
}

function predatoryLiquidationOrder(
  input: CroupierInput,
  quoteSize: { bid: number; ask: number },
  cluster: LiquidationCascadeCluster | null
): QuoteOrder | null {
  if (!cluster) {
    return null;
  }

  const offsetBps = Math.max(0, finiteNumber(input.predatoryOrderOffsetBps, 2));
  const offsetMultiplier = offsetBps / 10_000;

  if (cluster.side === "LONG") {
    if (input.inventory.stopBid) {
      return null;
    }

    return {
      clientOrderId: crypto.randomUUID(),
      side: "BID",
      price: snapGueantDiscretePrice(
        Math.max(0, cluster.priceStart * (1 - offsetMultiplier)),
        "BID",
        input
      ),
      size: predatorySize(input, cluster, quoteSize.bid),
      postOnly: true,
      strategy: "LIQUIDATION_ABSORPTION",
      clusterId: cluster.clusterId
    };
  }

  if (cluster.side === "SHORT") {
    if (input.inventory.stopAsk) {
      return null;
    }

    return {
      clientOrderId: crypto.randomUUID(),
      side: "ASK",
      price: snapGueantDiscretePrice(
        cluster.priceEnd * (1 + offsetMultiplier),
        "ASK",
        input
      ),
      size: predatorySize(input, cluster, quoteSize.ask),
      postOnly: true,
      strategy: "LIQUIDATION_ABSORPTION",
      clusterId: cluster.clusterId
    };
  }

  return null;
}

function selectLiquidationCluster(
  heatmap: LiquidationHeatmapState | null | undefined,
  book: InternalOrderBook
): LiquidationCascadeCluster | null {
  const mid = book.midPrice;

  if (!heatmap || mid === null || mid <= 0) {
    return null;
  }

  const maxDistancePct = Math.max(heatmap.cascadeDistancePct * 4, 0.02);
  const candidates = heatmap.clusters
    .filter((cluster) => cluster.instrumentCode === book.instrumentCode)
    .filter((cluster) => cluster.estimatedNotionalUsd >= heatmap.clusterThresholdUsd)
    .filter((cluster) => {
      const distance = cluster.distanceFromMidPct ?? Math.abs(cluster.centerPrice - mid) / mid;
      return distance <= maxDistancePct;
    });

  if (candidates.length === 0) {
    return null;
  }

  return [...candidates].sort((left, right) => {
    const leftDistance = left.distanceFromMidPct ?? Math.abs(left.centerPrice - mid) / mid;
    const rightDistance = right.distanceFromMidPct ?? Math.abs(right.centerPrice - mid) / mid;
    const leftScore = left.estimatedNotionalUsd / Math.max(leftDistance, 0.000001);
    const rightScore = right.estimatedNotionalUsd / Math.max(rightDistance, 0.000001);
    return rightScore - leftScore;
  })[0] ?? null;
}

function predatorySize(
  input: CroupierInput,
  cluster: LiquidationCascadeCluster,
  baseQuoteSize: number
): number {
  const clusterBase = cluster.centerPrice > 0
    ? cluster.estimatedNotionalUsd / cluster.centerPrice
    : cluster.estimatedBaseSize;
  const boundedByCluster = Math.max(0.00000001, clusterBase * 0.0025);

  return round(
    Math.max(0.00000001, Math.min(baseQuoteSize * 1.5, boundedByCluster)),
    8
  );
}

function estimateSlippageCost(
  book: InternalOrderBook,
  direction: TradeDirection,
  requestedSize: number
): number {
  const levels = direction === "LONG" ? book.asks : book.bids;
  const best = direction === "LONG" ? book.bestAsk : book.bestBid;

  if (!best || levels.length === 0) {
    return 0;
  }

  let remaining = requestedSize;
  let notional = 0;
  let filled = 0;

  for (const level of levels) {
    if (remaining <= 0) {
      break;
    }

    const take = Math.min(remaining, level.size);
    notional += take * level.price;
    filled += take;
    remaining -= take;
  }

  if (filled <= 0) {
    return 0;
  }

  return Math.abs(notional / filled - best);
}

function calculateFundingCarryCost(
  midPrice: number,
  requestedSize: number,
  direction: TradeDirection,
  fundingRateHourly: number,
  horizonHours: number
): number {
  if (!Number.isFinite(fundingRateHourly) || fundingRateHourly === 0 || horizonHours <= 0) {
    return 0;
  }

  const notional = midPrice * requestedSize;
  const signedCost =
    direction === "LONG"
      ? notional * fundingRateHourly * horizonHours
      : -notional * fundingRateHourly * horizonHours;
  const cap = notional * 0.05;

  return Math.max(-cap, Math.min(cap, signedCost));
}

function finiteNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeTickSize(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0.00000001;
}

function floorToTick(value: number, tickSize: number): number {
  return Math.floor((value + PRICE_EPSILON) / tickSize) * tickSize;
}

function ceilToTick(value: number, tickSize: number): number {
  return Math.ceil((value - PRICE_EPSILON) / tickSize) * tickSize;
}

function normalizeTickDecimal(value: number, tickSize: number): number {
  const decimals = decimalPlaces(tickSize);
  return Number(value.toFixed(Math.min(12, Math.max(0, decimals))));
}

function decimalPlaces(value: number): number {
  const text = String(value);
  const decimal = text.includes("e-")
    ? Number(text.split("e-")[1] ?? 8)
    : text.includes(".")
      ? text.split(".")[1]?.length ?? 0
      : 0;
  return Number.isFinite(decimal) ? decimal : 8;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
