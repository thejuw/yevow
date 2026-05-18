import type { JsonRecord, MarketRegime, MarketTick } from "../../types";

export type Timeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";
export type CascadeLiquidationSide = "LONG" | "SHORT" | "UNKNOWN";
export type CascadeForcedFlowSide = "BUY" | "SELL" | "UNKNOWN";
export type CascadeDirection = "LONG_LIQUIDATION" | "SHORT_LIQUIDATION";
export type CascadeRecoveryDirection = "LONG" | "SHORT";
export type CascadeRecoveryTriggerType = "STRUCTURAL_RECLAIM" | "VWAP_RECLAIM" | "IMPULSIVE_BAR";
export type CascadePositionStatus =
  | "PENDING_ENTRY"
  | "ENTERED"
  | "FIRST_TARGET_HIT"
  | "SECOND_TARGET_HIT"
  | "CLOSED"
  | "STOPPED_OUT"
  | "TIME_STOPPED";
export type CascadePositionIntentKind = "CLOSE" | "MOVE_STOP";
export type CascadeCloseReason =
  | "STOP_LOSS"
  | "FIRST_TARGET"
  | "SECOND_TARGET"
  | "TIME_STOP"
  | "MANUAL";

export interface Candle {
  instrumentCode: string;
  timeframe: Timeframe;
  openedAt: string;
  closedAt: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  notionalVolume: number;
  buyVolume: number;
  sellVolume: number;
  trades: number;
  isClosed: boolean;
}

export interface CandleAggregatorState {
  schemaVersion: "cascade.candle-aggregator.v1";
  activeCandles: Candle[];
  recentClosedCandles: Candle[];
  updatedAt: string | null;
}

export interface CandleAggregator {
  ingestTick(tick: MarketTick): Candle[];
  snapshot(instrumentCode: string, timeframe: Timeframe, count: number): Candle[];
  hydrate(state: CandleAggregatorState): void;
  serialize(): CandleAggregatorState;
}

export interface IndicatorPoint {
  observedAt: string;
  value: number;
}

export interface SwingPoint {
  instrumentCode: string;
  timeframe: Timeframe;
  kind: "HIGH" | "LOW";
  price: number;
  candleOpenedAt: string;
  detectedAt: string;
  strength: number;
}

export interface OpenInterestPoint {
  instrumentCode: string;
  observedAt: string;
  openInterest: number;
  delta: number;
}

export interface CascadeBacktestMetadata {
  schemaVersion: "cascade.backtest-metadata.v1";
  source: "D1" | "CSV" | "SYNTHETIC";
  notes?: string;
  parameters?: JsonRecord;
}

export interface LiquidationEvent {
  schemaVersion: "cascade.liquidation-event.v1";
  eventId: string;
  instrumentCode: string;
  sourceExchange: string;
  side: CascadeLiquidationSide;
  forcedFlowSide: CascadeForcedFlowSide;
  price: number;
  notionalUsd: number;
  baseSize: number;
  exchangeTimestamp: string | null;
  observedAt: string;
  raw: JsonRecord;
}

export interface LiquidationStreamContext {
  instrumentCode?: string | null;
  sourceExchange?: string | null;
  observedAt: string;
  fallbackPrice?: number | null;
}

export interface CascadeDetectorConfig {
  windowMs: number;
  notionalThresholdUsd: number;
  zScoreThreshold: number;
  lookbackHours: number;
  directionalPct: number;
  minPriceMoveAtr: number;
  minBaselineWindows: number;
  minCascadeSeparationMs: number;
  maxEventsPerInstrument: number;
}

export interface CascadeDetectorContext {
  observedAt?: string;
  atr1h: number | null;
  priceAtStart?: number | null;
}

export interface CascadeDetectorState {
  schemaVersion: "cascade.detector.v1";
  events: LiquidationEvent[];
  lastCascadeAtByInstrument: Record<string, string>;
}

export interface CascadeEvent {
  schemaVersion: "cascade.event.v1";
  cascadeId: string;
  instrumentCode: string;
  direction: CascadeDirection;
  detectedAt: string;
  windowStartAt: string;
  windowEndAt: string;
  liquidationNotional: number;
  liquidationCount: number;
  zScore: number;
  priceAtStart: number;
  priceAtPeak: number;
  priceMoveAtr: number;
  directionalPct: number;
  rawEvents: LiquidationEvent[];
}

export interface AbsorptionAnalyzerConfig {
  absorptionWindowMs: number;
  priceBandBps: number;
  minHoldSeconds: number;
  oiStabilityBps: number;
  maxActiveCascades: number;
}

export interface AbsorptionObservation {
  instrumentCode: string;
  observedAt: string;
  price: number;
  takerBuyVolume: number;
  takerSellVolume: number;
  cumulativeVolumeDelta: number;
  openInterest: number | null;
}

export interface AbsorptionCriteria {
  priceHeld: boolean;
  takerExhaustion: boolean;
  cvdReversal: boolean;
  openInterestStabilized: boolean;
}

export interface AbsorptionConfirmed {
  schemaVersion: "cascade.absorption-confirmed.v1";
  cascadeId: string;
  instrumentCode: string;
  direction: CascadeDirection;
  confirmedAt: string;
  elapsedMs: number;
  price: number;
  criteria: AbsorptionCriteria;
  observations: number;
}

export interface AbsorptionAnalyzerState {
  schemaVersion: "cascade.absorption-analyzer.v1";
  activeCascadeIds: string[];
}

export interface CascadeRecoverySignalTargets {
  partial1: { price: number; rMultiple: number; sizePct: number };
  partial2: { price: number; rMultiple: number; sizePct: number };
  runner: { trailingType: "ATR" | "EMA"; trailingParam: number; sizePct: number };
}

export interface CascadeRecoverySignal {
  schemaVersion: "cascade.recovery-signal.v1";
  signalId: string;
  cascadeId: string;
  instrumentCode: string;
  direction: CascadeRecoveryDirection;
  triggerType: CascadeRecoveryTriggerType;
  entryPrice: number;
  stopPrice: number;
  rDistance: number;
  targets: CascadeRecoverySignalTargets;
  timeStopAt: string;
  confidence: number;
  context: JsonRecord;
  emittedAt: string;
}

export interface CascadeRecoverySignalConfig {
  entryWindowSeconds: number;
  impulsiveBarBodyAtr: number;
  impulsiveBarVolumeMult: number;
  stopBufferAtr: number;
  minStopDistanceBps: number;
  maxStopDistanceBps: number;
  minTimeSinceLastCascadeSeconds: number;
  newsBlackoutMinutes: number;
  maxRealizedVolPercentile: number;
  timeStopHours: number;
  partial1R: number;
  partial1SizePct: number;
  partial2R: number;
  partial2SizePct: number;
  runnerTrailingType: "ATR" | "EMA";
  runnerTrailingParam: number;
}

export interface CascadeRecoverySignalInput {
  cascade: CascadeEvent;
  absorption: AbsorptionConfirmed;
  reclaimCandle: Candle;
  recent1mCandles: Candle[];
  atr1m: number | null;
  atr1h: number | null;
  preCascadeSwingLow: number | null;
  preCascadeSwingHigh: number | null;
  cascadeVwap: number | null;
  cvd1m: number;
  openInterestDelta: number | null;
  oracleRegime: MarketRegime | "UNKNOWN";
  recentSecondCascadeAt: string | null;
  majorNewsWithinBlackout: boolean;
  realizedVolPercentile1h: number | null;
  dailyLossLimitBreached: boolean;
  weeklyLossLimitBreached: boolean;
  observedAt: string;
}

export interface CascadeRecoverySignalRejection {
  schemaVersion: "cascade.recovery-signal-rejection.v1";
  cascadeId: string;
  instrumentCode: string;
  rejectedAt: string;
  reasons: string[];
  context: JsonRecord;
}

export type CascadeRecoverySignalResult =
  | { accepted: true; signal: CascadeRecoverySignal }
  | { accepted: false; rejection: CascadeRecoverySignalRejection };

export interface PositionSizeInput {
  equity: number;
  riskPerTradePct: number;
  entryPrice: number;
  stopPrice: number;
  maxPositionNotionalPct: number;
  assetLiquidityCap: number;
  currentHeat: number;
  heatCapPct: number;
}

export interface PositionSizeDecision {
  approved: boolean;
  units: number;
  notionalUsd: number;
  riskUsd: number;
  riskPct: number;
  heatAfterPct: number;
  limitingFactor: "RISK" | "NOTIONAL" | "LIQUIDITY" | "HEAT" | "INVALID_INPUT";
  reason: string;
  bounds: {
    riskUnits: number;
    notionalUnits: number;
    liquidityUnits: number;
    heatUnits: number;
  };
}

export interface CascadeOpenPosition {
  positionId: string;
  signalId: string;
  cascadeId: string;
  instrumentCode: string;
  direction: CascadeRecoveryDirection;
  status: CascadePositionStatus;
  entryPrice: number;
  currentStopPrice: number;
  initialStopPrice: number;
  totalSize: number;
  remainingSize: number;
  initialRiskPct: number;
  rDistance: number;
  targets: CascadeRecoverySignalTargets;
  timeStopAt: string;
  firstTargetTaken: boolean;
  secondTargetTaken: boolean;
  enteredAt: string | null;
  updatedAt: string;
}

export interface PositionManagerTick {
  instrumentCode: string;
  price: number;
  observedAt: string;
  candles?: Candle[];
  atr?: number | null;
}

export interface CascadePositionIntent {
  intentId: string;
  positionId: string;
  signalId: string;
  instrumentCode: string;
  kind: CascadePositionIntentKind;
  closeReason?: CascadeCloseReason;
  action: "BUY" | "SELL";
  orderType: "IOC";
  executionStyle: "TAKER_IOC" | "TAKER_MARKET";
  size: number;
  referencePrice: number;
  newStopPrice?: number;
  createdAt: string;
}

export interface PositionManagerUpdate {
  position: CascadeOpenPosition;
  intents: CascadePositionIntent[];
}

export interface RiskBlockDecision {
  blocked: boolean;
  reason?: "DAILY_LOSS_LIMIT" | "WEEKLY_LOSS_LIMIT" | "CONSECUTIVE_LOSSES" | "DRAWDOWN_LIMIT";
  resumesAt?: string;
  metadata?: JsonRecord;
}
