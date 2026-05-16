import type {
  InternalOrderBook,
  MarketTick,
  ShadowQueueDecision,
  ShadowQueueFill,
  ShadowQueueState
} from "../types";

const EMPTY = 0;
const ACTIVE = 1;
const PENDING_DRIFT = 2;
const SIDE_BUY = 1;
const SIDE_SELL = -1;
const PRICE_EPSILON = 1e-9;

const F_SIZE = 0;
const F_QUEUE_AHEAD = 1;
const F_P0_MID = 2;
const F_FILL_SIZE = 3;
const F_FILL_PRICE = 4;
const F_TRADES_SINCE_FILL = 5;
const F_QUEUE_ORIGINAL = 6;
const F_COUNT = 7;

export interface GhostBookConfig {
  capacity: number;
  driftTradeDelay: number;
  queueDepthMultiplier: number;
  baseSpreadBps: number;
  latencyBudgetMs: number;
  minSize: number;
}

export interface GhostBookObservation {
  fills: ShadowQueueFill[];
  decisions: ShadowQueueDecision[];
  state: ShadowQueueState;
}

export class GhostBook {
  private readonly stateBySlot: Uint8Array;
  private readonly sideBySlot: Int8Array;
  private readonly numeric: Float32Array;
  private readonly priceBySlot: Float64Array;
  private readonly sequenceBySlot: Float64Array;
  private readonly createdAtMsBySlot: Float64Array;
  private readonly instrumentBySlot: string[];
  private readonly fillIdBySlot: string[];
  private writeCursor = 0;
  private ghostFills = 0;
  private greenLights = 0;
  private redLights = 0;
  private noEdgeSignals = 0;
  private invertedSignals = 0;
  private confirmedSignals = 0;
  private lastFill: ShadowQueueFill | null = null;
  private lastDecision: ShadowQueueDecision | null = null;

  constructor(private readonly config: GhostBookConfig) {
    this.stateBySlot = new Uint8Array(config.capacity);
    this.sideBySlot = new Int8Array(config.capacity);
    this.numeric = new Float32Array(config.capacity * F_COUNT);
    this.priceBySlot = new Float64Array(config.capacity);
    this.sequenceBySlot = new Float64Array(config.capacity);
    this.createdAtMsBySlot = new Float64Array(config.capacity);
    this.instrumentBySlot = new Array<string>(config.capacity).fill("");
    this.fillIdBySlot = new Array<string>(config.capacity).fill("");
  }

  hydrate(state: ShadowQueueState | undefined): void {
    if (!state) {
      return;
    }

    this.ghostFills = finiteCounter(state.ghostFills);
    this.greenLights = finiteCounter(state.greenLights);
    this.redLights = finiteCounter(state.redLights);
    this.noEdgeSignals = finiteCounter(state.noEdgeSignals);
    this.invertedSignals = finiteCounter(state.invertedSignals);
    this.confirmedSignals = finiteCounter(state.confirmedSignals);
    this.lastFill = state.lastFill ?? null;
    this.lastDecision = state.lastDecision ?? null;
  }

  injectBbo(book: InternalOrderBook, observedAt: string): void {
    if (book.bestBid !== null && book.bestBid > 0) {
      this.injectOne(
        book.instrumentCode,
        SIDE_BUY,
        book.bestBid,
        topLevelSize(book, "BUY"),
        book.sequence,
        observedAt
      );
    }

    if (book.bestAsk !== null && book.bestAsk > 0) {
      this.injectOne(
        book.instrumentCode,
        SIDE_SELL,
        book.bestAsk,
        topLevelSize(book, "SELL"),
        book.sequence,
        observedAt
      );
    }
  }

  observeTrade(
    tick: MarketTick,
    book: InternalOrderBook,
    observedAt: string
  ): GhostBookObservation {
    const startedAt = highResolutionNow();
    const fills: ShadowQueueFill[] = [];
    const decisions: ShadowQueueDecision[] = [];
    let fillCount = 0;
    let decisionCount = 0;

    if (
      tick.size <= 0 ||
      tick.price <= 0 ||
      book.midPrice === null ||
      book.midPrice <= 0 ||
      (tick.side !== "buy" && tick.side !== "sell")
    ) {
      return {
        fills,
        decisions,
        state: this.snapshot(observedAt)
      };
    }

    for (let slot = 0; slot < this.config.capacity; slot += 1) {
      const decision = this.advancePendingDrift(
        slot,
        tick,
        book,
        observedAt,
        roundLatency(highResolutionNow() - startedAt)
      );
      if (decision) {
        decisions[decisionCount] = decision;
        decisionCount += 1;
      }
    }

    for (let slot = 0; slot < this.config.capacity; slot += 1) {
      const fill = this.consumeActiveSlot(slot, tick, book, observedAt);
      if (fill) {
        fills[fillCount] = fill;
        fillCount += 1;
      }
    }

    return {
      fills,
      decisions,
      state: this.snapshot(observedAt)
    };
  }

  snapshot(observedAt: string | null): ShadowQueueState {
    let activeOrders = 0;
    let pendingDrifts = 0;

    for (let slot = 0; slot < this.config.capacity; slot += 1) {
      if (this.stateBySlot[slot] === ACTIVE) {
        activeOrders += 1;
      } else if (this.stateBySlot[slot] === PENDING_DRIFT) {
        pendingDrifts += 1;
      }
    }

    return {
      schemaVersion: "shadow-queue.v1",
      capacity: this.config.capacity,
      activeOrders,
      pendingDrifts,
      ghostFills: this.ghostFills,
      greenLights: this.greenLights,
      redLights: this.redLights,
      noEdgeSignals: this.noEdgeSignals,
      invertedSignals: this.invertedSignals,
      confirmedSignals: this.confirmedSignals,
      driftTradeDelay: this.config.driftTradeDelay,
      latencyBudgetMs: this.config.latencyBudgetMs,
      baseSpreadBps: this.config.baseSpreadBps,
      queueDepthMultiplier: this.config.queueDepthMultiplier,
      lastFill: this.lastFill,
      lastDecision: this.lastDecision,
      updatedAt: observedAt
    };
  }

  recordDecision(decision: ShadowQueueDecision): void {
    this.lastDecision = decision;
  }

  private injectOne(
    instrumentCode: string,
    side: typeof SIDE_BUY | typeof SIDE_SELL,
    price: number,
    topDepth: number,
    sequence: number,
    observedAt: string
  ): void {
    if (!Number.isFinite(topDepth) || topDepth <= 0) {
      return;
    }

    const slot = this.nextWritableSlot();
    const virtualSize = Math.max(
      this.config.minSize,
      Math.min(Math.max(this.config.minSize, topDepth * 0.02), Math.max(this.config.minSize, topDepth))
    );
    const queueAhead = Math.max(0, topDepth * this.config.queueDepthMultiplier);

    this.stateBySlot[slot] = ACTIVE;
    this.sideBySlot[slot] = side;
    this.instrumentBySlot[slot] = instrumentCode;
    this.priceBySlot[slot] = price;
    this.sequenceBySlot[slot] = sequence;
    this.createdAtMsBySlot[slot] = Date.parse(observedAt) || Date.now();
    this.set(slot, F_SIZE, virtualSize);
    this.set(slot, F_QUEUE_AHEAD, queueAhead);
    this.set(slot, F_QUEUE_ORIGINAL, queueAhead);
    this.set(slot, F_P0_MID, 0);
    this.set(slot, F_FILL_SIZE, 0);
    this.set(slot, F_FILL_PRICE, 0);
    this.set(slot, F_TRADES_SINCE_FILL, 0);
    this.fillIdBySlot[slot] = "";
  }

  private nextWritableSlot(): number {
    for (let attempt = 0; attempt < this.config.capacity; attempt += 1) {
      const slot = (this.writeCursor + attempt) % this.config.capacity;
      if (this.stateBySlot[slot] !== PENDING_DRIFT) {
        this.writeCursor = (slot + 1) % this.config.capacity;
        return slot;
      }
    }

    const slot = this.writeCursor;
    this.writeCursor = (this.writeCursor + 1) % this.config.capacity;
    return slot;
  }

  private advancePendingDrift(
    slot: number,
    tick: MarketTick,
    book: InternalOrderBook,
    observedAt: string,
    decisionLatencyMs: number
  ): ShadowQueueDecision | null {
    if (
      this.stateBySlot[slot] !== PENDING_DRIFT ||
      this.instrumentBySlot[slot] !== tick.instrumentCode ||
      book.midPrice === null ||
      book.midPrice <= 0
    ) {
      return null;
    }

    const tradesSinceFill = this.get(slot, F_TRADES_SINCE_FILL) + 1;
    this.set(slot, F_TRADES_SINCE_FILL, tradesSinceFill);

    if (tradesSinceFill < this.config.driftTradeDelay) {
      return null;
    }

    const side = this.sideBySlot[slot] === SIDE_BUY ? "BUY" : "SELL";
    const p0MidPrice = this.get(slot, F_P0_MID);
    const pnMidPrice = book.midPrice;
    const microDrift = pnMidPrice - p0MidPrice;
    const tickThreshold = Math.max(book.tickSize, Number.EPSILON);
    const favorable =
      side === "BUY" ? microDrift >= tickThreshold : microDrift <= -tickThreshold;
    const adverse =
      side === "BUY" ? microDrift <= -tickThreshold : microDrift >= tickThreshold;
    const action = favorable ? "GREEN_LIGHT" : adverse ? "RED_LIGHT" : "NO_EDGE";
    const dispatchSide =
      action === "GREEN_LIGHT" ? side : action === "RED_LIGHT" ? oppositeSide(side) : null;

    if (action === "GREEN_LIGHT") {
      this.greenLights += 1;
      this.confirmedSignals += 1;
    } else if (action === "RED_LIGHT") {
      this.redLights += 1;
      this.invertedSignals += 1;
    } else {
      this.noEdgeSignals += 1;
    }

    this.stateBySlot[slot] = EMPTY;
    const fillId =
      this.fillIdBySlot[slot] ||
      `vlo:${this.instrumentBySlot[slot]}:${this.sequenceBySlot[slot]}:${slot}`;
    this.fillIdBySlot[slot] = "";
    const decision: ShadowQueueDecision = {
      decisionId: `vlo-decision:${fillId}:${Date.parse(observedAt) || observedAt}`,
      fillId,
      instrumentCode: this.instrumentBySlot[slot],
      originalSide: side,
      action,
      dispatchSide,
      p0MidPrice,
      pnMidPrice,
      microDrift,
      driftTrades: tradesSinceFill,
      tickThreshold,
      decisionLatencyMs,
      tradeIntentId: null,
      reason:
        action === "GREEN_LIGHT"
          ? "Post-fill drift confirmed the original shadow queue side."
          : action === "RED_LIGHT"
            ? "Post-fill drift moved against the shadow queue side; invert the signal."
            : "Post-fill drift stayed inside the minimum tick threshold.",
      decidedAt: observedAt
    };
    this.lastDecision = decision;

    return decision;
  }

  private consumeActiveSlot(
    slot: number,
    tick: MarketTick,
    book: InternalOrderBook,
    observedAt: string
  ): ShadowQueueFill | null {
    if (
      this.stateBySlot[slot] !== ACTIVE ||
      this.instrumentBySlot[slot] !== tick.instrumentCode ||
      book.midPrice === null ||
      book.midPrice <= 0
    ) {
      return null;
    }

    const sideCode = this.sideBySlot[slot];
    const isBidConsumed =
      sideCode === SIDE_BUY &&
      tick.side === "sell" &&
      tick.price <= this.priceBySlot[slot] + PRICE_EPSILON;
    const isAskConsumed =
      sideCode === SIDE_SELL &&
      tick.side === "buy" &&
      tick.price >= this.priceBySlot[slot] - PRICE_EPSILON;

    if (!isBidConsumed && !isAskConsumed) {
      return null;
    }

    const remainingAhead = this.get(slot, F_QUEUE_AHEAD) - tick.size;
    this.set(slot, F_QUEUE_AHEAD, remainingAhead);

    if (remainingAhead > 0) {
      return null;
    }

    const fillSize = this.get(slot, F_SIZE);
    this.stateBySlot[slot] = PENDING_DRIFT;
    this.set(slot, F_P0_MID, book.midPrice);
    this.set(slot, F_FILL_SIZE, fillSize);
    this.set(slot, F_FILL_PRICE, this.priceBySlot[slot]);
    this.set(slot, F_TRADES_SINCE_FILL, 0);
    this.ghostFills += 1;

    const fillId = `vlo:${this.instrumentBySlot[slot]}:${tick.sequence}:${slot}`;
    const fill: ShadowQueueFill = {
      fillId,
      instrumentCode: this.instrumentBySlot[slot],
      side: sideCode === SIDE_BUY ? "BUY" : "SELL",
      price: this.priceBySlot[slot],
      size: fillSize,
      queueAhead: this.get(slot, F_QUEUE_ORIGINAL),
      p0MidPrice: book.midPrice,
      fillTradeSequence: tick.sequence,
      filledAt: observedAt
    };
    this.sequenceBySlot[slot] = tick.sequence;
    this.fillIdBySlot[slot] = fillId;
    this.lastFill = fill;

    return fill;
  }

  private get(slot: number, field: number): number {
    return this.numeric[slot * F_COUNT + field] ?? 0;
  }

  private set(slot: number, field: number, value: number): void {
    this.numeric[slot * F_COUNT + field] = Number.isFinite(value) ? value : 0;
  }
}

function topLevelSize(book: InternalOrderBook, side: "BUY" | "SELL"): number {
  const levels = side === "BUY" ? book.bids : book.asks;
  const size = levels[0]?.size;
  return typeof size === "number" && Number.isFinite(size) && size > 0 ? size : 0;
}

function oppositeSide(side: "BUY" | "SELL"): "BUY" | "SELL" {
  return side === "BUY" ? "SELL" : "BUY";
}

function finiteCounter(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function highResolutionNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function roundLatency(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
