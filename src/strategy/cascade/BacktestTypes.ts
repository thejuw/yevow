import type { GlobalRiskConfig, JsonRecord } from "../../types";
import type { AbsorptionAnalyzer } from "./AbsorptionAnalyzer";
import type { CascadeDetector } from "./CascadeDetector";
import type { CascadeRecoverySignalEngine } from "./CascadeRecoverySignal";
import type { HeatManager } from "./HeatManager";
import type { PositionManager } from "./PositionManager";
import type {
  AbsorptionConfirmed,
  Candle,
  CascadeEvent,
  CascadeRecoverySignal,
  LiquidationEvent,
  OpenInterestPoint
} from "./types";

export interface BacktestConfig {
  feeBps: number;
  slippageBps: number;
  adverseSelectionMinBps: number;
  adverseSelectionMaxBps: number;
  riskPerTradePct: number;
  strategyMode: GlobalRiskConfig["STRATEGY_MODE"];
  cascadeWindowMs: number;
  cascadeNotionalThresholdUsd: number;
  cascadeZScoreThreshold: number;
  cascadeAssetProfiles: string;
  cascadeLookbackHours: number;
  cascadeDirectionalPct: number;
  cascadeMinPriceMoveAtr: number;
  cascadeMinBaselineWindows: number;
  cascadeMinSeparationMs: number;
  absorptionWindowMs: number;
  absorptionPriceBandBps: number;
  absorptionMinHoldSeconds: number;
  oiStabilityBps: number;
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
  maxPositionNotionalPct: number;
  assetLiquidityCapUsd: number;
  heatCapPct: number;
  missingOpenInterestPolicy: "BLOCK" | "ASSUME_STABLE";
}

export interface BacktestInput {
  fromDate: string;
  toDate: string;
  instruments: string[];
  startingEquity: number;
  config: Partial<BacktestConfig>;
  candles?: Candle[];
  liquidations?: LiquidationEvent[];
  openInterest?: OpenInterestPoint[];
}

export interface BacktestTrade {
  tradeId: string;
  instrumentCode: string;
  side: "BUY" | "SELL";
  status: "ENTRY" | "EXIT" | "REJECTED";
  cascadeId: string | null;
  signalId: string | null;
  entryAt: string;
  exitAt: string;
  entryPrice: number;
  exitPrice: number;
  size: number;
  pnl: number;
  rMultiple: number | null;
  fees: number;
  slippageBps: number;
  rationale: string;
}

export interface BacktestValidationCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  metadata?: JsonRecord;
}

export interface BacktestReport {
  schemaVersion: "cascade.backtest-report.v2";
  fromDate: string;
  toDate: string;
  instruments: string[];
  startingEquity: number;
  endingEquity: number;
  totalPnl: number;
  maxDrawdownPct: number;
  equityCurve: { observedAt: string; equity: number }[];
  drawdownCurve: { observedAt: string; drawdownPct: number }[];
  trades: BacktestTrade[];
  cascades: CascadeEvent[];
  signals: CascadeRecoverySignal[];
  rejectedSignals: JsonRecord[];
  perAssetStats: Record<string, { trades: number; pnl: number; winRate: number }>;
  regimeStats: Record<string, { trades: number; pnl: number }>;
  parameterSensitivity: { parameter: string; value: number; pnl: number; maxDrawdownPct: number }[];
  dataQuality: {
    candleCount: number;
    liquidationCount: number;
    openInterestCount: number;
    slippageSampleCount: number;
    source: "D1" | "REQUEST_PAYLOAD" | "MIXED" | "INSUFFICIENT";
  };
  validation: {
    ok: boolean;
    checks: BacktestValidationCheck[];
  };
  metadata: JsonRecord;
}

export interface CandleRow {
  instrument_code: string;
  opened_at: string;
  closed_at: string;
  open: number | string;
  high: number | string;
  low: number | string;
  close: number | string;
  volume: number | string;
  notional_volume: number | string;
  buy_volume: number | string;
  sell_volume: number | string;
  trades: number | string;
  is_closed: number | string;
}

export interface LiquidationRow {
  event_id: string;
  instrument_code: string;
  source_exchange: string;
  side: string;
  forced_flow_side: string;
  price: number | string;
  notional_usd: number | string;
  base_size: number | string;
  exchange_timestamp: string | null;
  observed_at: string;
  raw_json: string | null;
}

export interface SlippageRow {
  slippage_bps: number | string;
}

export interface ReplayRuntime {
  config: BacktestConfig;
  candlesByInstrument: Map<string, Candle[]>;
  openInterestByInstrument: Map<string, OpenInterestPoint[]>;
  slippageSamples: number[];
  positionManager: PositionManager;
  heatManager: HeatManager;
  detector: CascadeDetector;
  absorptionAnalyzer: AbsorptionAnalyzer;
  signalEngine: CascadeRecoverySignalEngine;
  cascadesById: Map<string, CascadeEvent>;
  absorptionsById: Map<string, AbsorptionConfirmed>;
  cvdByInstrument: Map<string, number>;
  entryPriceByPosition: Map<string, number>;
}

export type TimelineEvent =
  | { kind: "LIQUIDATION"; observedAt: string; liquidation: LiquidationEvent }
  | { kind: "CANDLE"; observedAt: string; candle: Candle };
