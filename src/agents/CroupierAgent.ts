import type {
  InternalOrderBook,
  InventoryState,
  LeadLagMetrics,
  MacroBias,
  OracleState,
  QuoteOrder,
  QuoteSignal,
  SentimentState,
  TradeDirection,
  TradeIntent
} from "../types";

const DEFAULT_MIN_EV_THRESHOLD = 0;
const DEFAULT_FEE_BPS = 5;
const ADVERSE_SELECTION_CRITICAL_COST = 0.02;

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
  private sustainedToxicTicks = 0;

  constructor(config: CroupierConfig = {}) {
    this.minEvThreshold = finiteNumber(config.minEvThreshold, DEFAULT_MIN_EV_THRESHOLD);
    this.exchangeFeeBps = finiteNumber(config.exchangeFeeBps, DEFAULT_FEE_BPS);
    this.riskAversionFactor = finiteNumber(config.riskAversionFactor, 0.01);
    this.amm = new AMMEngine(config.minTickChange ?? 0.00000001, this.riskAversionFactor);
  }

  evaluate(input: CroupierInput): CroupierDecision {
    const adverseSelectionCost = this.calculateInformationPremium(input.toxicityScore);
    this.sustainedToxicTicks =
      input.toxicityScore > 0.7 ? this.sustainedToxicTicks + 1 : 0;
    const pullAllQuotes =
      this.sustainedToxicTicks >= 3 && adverseSelectionCost >= ADVERSE_SELECTION_CRITICAL_COST;
    const baseMinEvThreshold = finiteNumber(input.minEvThreshold, this.minEvThreshold);
    const macroThresholdMultiplier = macroBiasThresholdMultiplier(
      input.macroBias,
      preferredDirection(input),
      input.book.instrumentCode
    );
    const minEvThreshold =
      baseMinEvThreshold *
      Math.exp(Math.max(0, input.toxicityScore - 0.7) * 3) *
      sentimentMultiplier(input.sentiment, preferredDirection(input)) *
      macroThresholdMultiplier;
    const quote = this.amm.quote(input, adverseSelectionCost);
    const intent = pullAllQuotes
      ? null
      : this.createIntent(input, minEvThreshold, adverseSelectionCost);

    return {
      intent: intent && intent.expectedValue > intent.minEvThreshold ? intent : null,
      quote,
      pullAllQuotes,
      adverseSelectionCost,
      minEvThreshold
    };
  }

  calculateInformationPremium(vpinScore: number): number {
    const score = Math.min(1, Math.max(0, vpinScore));
    return score <= 0.7 ? score * 0.005 : 0.0035 + (score - 0.7) ** 2 * 0.2;
  }

  private createIntent(
    input: CroupierInput,
    minEvThreshold: number,
    adverseSelectionCost: number
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
    const inventoryPenalty = Math.abs(input.inventory.netDelta) * this.riskAversionFactor;
    const leadLagBoost = input.leadLag.executable ? Math.max(0, input.leadLag.expectedValue ?? 0) : 0;
    const macroBiasEv = mid * 0.0005 * macroScore;
    const executionCosts =
      fees +
      estimatedSlippage +
      adverseSelectionCost * mid +
      executionCostBuffer +
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
      timeInForce: "GTC",
      intendedPrice: input.book.midPrice ?? input.book.bestBid ?? input.book.bestAsk ?? 0,
      expectedPrice: input.book.midPrice ?? input.book.bestBid ?? input.book.bestAsk ?? 0,
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
        `Croupier EV calculation with toxicity, sentiment, inventory, slippage, lead-lag and macro bias inputs. ` +
        `macroBias=${input.macroBias?.direction ?? "NEUTRAL"} score=${round(macroScore, 4)}`,
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
    const horizon = Math.max(0.1, 1 - input.toxicityScore * 0.5);
    const variance = input.oracle.volatility ** 2;
    const topDepth =
      input.book.bids.slice(0, 5).reduce((sum, level) => sum + level.size, 0) +
      input.book.asks.slice(0, 5).reduce((sum, level) => sum + level.size, 0);
    const arrivalIntensity =
      Math.log1p(topDepth) / Math.max(1, input.book.spreadBps ?? 1);
    const liquidityTightening = 1 / Math.sqrt(1 + arrivalIntensity);
    const reservationPrice =
      mid - input.inventory.netDelta * this.riskAversionFactor * variance * horizon;
    const halfSpread =
      Math.max(input.book.spread ?? mid * 0.0001, mid * input.oracle.volatility * 0.25) *
        liquidityTightening +
      adverseSelectionCost * mid;
    const imbalance = input.book.weightedImbalance ?? 0;
    const toxicBuyPressure = Math.max(0, imbalance) * input.toxicityScore;
    const toxicSellPressure = Math.max(0, -imbalance) * input.toxicityScore;
    const bidHalfSpread = halfSpread * (1 + toxicSellPressure);
    const askHalfSpread = halfSpread * (1 + toxicBuyPressure);
    const inventoryAdjustment =
      input.inventory.netDelta * this.riskAversionFactor * Math.max(input.book.spread ?? 0, 0);
    const bid = reservationPrice - bidHalfSpread - inventoryAdjustment;
    const ask = reservationPrice + askHalfSpread - inventoryAdjustment;
    const quoteSize = calculateQuoteSize(input);
    const orders: QuoteOrder[] = [];

    if (!input.inventory.stopBid) {
      orders.push({
        clientOrderId: crypto.randomUUID(),
        side: "BID",
        price: round(bid, 8),
        size: quoteSize.bid,
        postOnly: true
      });
    }

    if (!input.inventory.stopAsk) {
      orders.push({
        clientOrderId: crypto.randomUUID(),
        side: "ASK",
        price: round(ask, 8),
        size: quoteSize.ask,
        postOnly: true
      });
    }

    return {
      schemaVersion: "quote-signal.v1",
      signalId: crypto.randomUUID(),
      instrumentCode: input.book.instrumentCode,
      marketKey: input.book.marketKey,
      reservationPrice: round(reservationPrice, 8),
      optimalSpread: round(halfSpread * 2, 8),
      orders,
      createdAt: input.observedAt
    };
  }
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
  const toxicityScale = Math.max(0.1, 1 - input.toxicityScore);

  return {
    bid: round(Math.max(0.00000001, Math.min(bidRoom, Math.max(0.00000001, bidDepth * 0.02)) * toxicityScale), 8),
    ask: round(Math.max(0.00000001, Math.min(askRoom, Math.max(0.00000001, askDepth * 0.02)) * toxicityScale), 8)
  };
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

function finiteNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
