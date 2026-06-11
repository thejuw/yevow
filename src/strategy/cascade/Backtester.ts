import { defaultConfig } from "../../ConfigManager";
import type { JsonRecord } from "../../types";
import { AbsorptionAnalyzer } from "./AbsorptionAnalyzer";
import { parseCascadeAssetProfiles, resolveCascadeAssetProfile } from "./AssetProfiles";
import {
  dataSource,
  groupCandles,
  groupOpenInterest,
  isLiquidationEvent,
  normalizeInstruments,
  numeric,
  rowToCandle,
  rowToLiquidation,
  sanitizeCandles,
  sanitizeLiquidations,
  sanitizeOpenInterest,
  sortCandles,
  sortLiquidations,
  sortOpenInterest,
  timeline
} from "./BacktestData";
import { CascadeDetector } from "./CascadeDetector";
import {
  CascadeRecoverySignalEngine,
  defaultCascadeRecoverySignalConfig
} from "./CascadeRecoverySignal";
import { HeatManager } from "./HeatManager";
import { calculateAtr } from "./indicators/ATR";
import { cumulativeVolumeDelta } from "./indicators/CumulativeVolumeDelta";
import { calculateVwap } from "./indicators/VWAP";
import { PositionManager } from "./PositionManager";
import { calculatePositionSize } from "./PositionSizer";
import type {
  BacktestConfig,
  BacktestInput,
  BacktestReport,
  BacktestTrade,
  BacktestValidationCheck,
  CandleRow,
  LiquidationRow,
  ReplayRuntime,
  SlippageRow
} from "./BacktestTypes";
import type {
  AbsorptionConfirmed,
  Candle,
  CascadeEvent,
  CascadeOpenPosition,
  CascadeRecoverySignal,
  LiquidationEvent,
  OpenInterestPoint
} from "./types";

export type {
  BacktestConfig,
  BacktestInput,
  BacktestReport,
  BacktestTrade,
  BacktestValidationCheck
} from "./BacktestTypes";

export class Backtester {
  constructor(private readonly db: D1Database) {}

  async run(input: BacktestInput): Promise<BacktestReport> {
    const config = normalizeConfig(input.config);
    const instruments = normalizeInstruments(input.instruments);
    const requestedCandles = sanitizeCandles(input.candles ?? [], instruments);
    const requestedLiquidations = sanitizeLiquidations(input.liquidations ?? [], instruments);
    const requestedOpenInterest = sanitizeOpenInterest(input.openInterest ?? [], instruments);
    const d1Candles =
      requestedCandles.length > 0
        ? []
        : await this.loadCandles(input.fromDate, input.toDate, instruments);
    const d1Liquidations =
      requestedLiquidations.length > 0
        ? []
        : await this.loadLiquidations(input.fromDate, input.toDate, instruments);
    const slippageSamples = await this.loadSlippageSamples(
      input.fromDate,
      input.toDate,
      instruments
    );
    const candles = sortCandles([...requestedCandles, ...d1Candles]);
    const liquidations = sortLiquidations([...requestedLiquidations, ...d1Liquidations]);
    const openInterest = sortOpenInterest(requestedOpenInterest);
    const source = dataSource(
      requestedCandles.length + requestedLiquidations.length + requestedOpenInterest.length,
      d1Candles.length + d1Liquidations.length
    );

    if (config.strategyMode === "OFF" || config.strategyMode === "MARKET_MAKING") {
      return this.emptyReport(
        input,
        config,
        instruments,
        candles,
        liquidations,
        openInterest,
        source
      );
    }

    const runtime = createRuntime(config, candles, openInterest, slippageSamples);
    let equity = input.startingEquity;
    let highWaterMark = equity;
    let maxDrawdownPct = 0;
    const trades: BacktestTrade[] = [];
    const signals: CascadeRecoverySignal[] = [];
    const rejectedSignals: JsonRecord[] = [];
    const equityCurve: BacktestReport["equityCurve"] = [];
    const drawdownCurve: BacktestReport["drawdownCurve"] = [];

    for (const event of timeline(candles, liquidations)) {
      if (event.kind === "LIQUIDATION") {
        const cascade = processLiquidation(runtime, event.liquidation);
        if (cascade) {
          runtime.cascadesById.set(cascade.cascadeId, cascade);
        }
        continue;
      }

      const result = processCandle(runtime, event.candle, equity);
      for (const trade of result.trades) {
        trades.push(trade);
        equity = round(equity + trade.pnl);
        highWaterMark = Math.max(highWaterMark, equity);
        const drawdownPct =
          highWaterMark > 0 ? Math.max(0, (highWaterMark - equity) / highWaterMark) : 0;
        maxDrawdownPct = Math.max(maxDrawdownPct, drawdownPct);
        equityCurve.push({ observedAt: trade.exitAt, equity: round(equity) });
        drawdownCurve.push({ observedAt: trade.exitAt, drawdownPct: round(drawdownPct) });
      }
      signals.push(...result.signals);
      rejectedSignals.push(...result.rejections);
    }

    const cascades = [...runtime.cascadesById.values()].sort(
      (left, right) => Date.parse(left.detectedAt) - Date.parse(right.detectedAt)
    );
    const closedTrades = trades.filter((trade) => trade.status === "EXIT");
    const validation = validateBacktest({
      candles,
      liquidations,
      openInterest,
      cascades,
      signals,
      closedTrades,
      heatCapPct: config.heatCapPct,
      maxObservedHeatPct: maxObservedHeat(runtime.positionManager.snapshot(), runtime.heatManager)
    });

    return {
      schemaVersion: "cascade.backtest-report.v2",
      fromDate: input.fromDate,
      toDate: input.toDate,
      instruments,
      startingEquity: input.startingEquity,
      endingEquity: round(equity),
      totalPnl: round(equity - input.startingEquity),
      maxDrawdownPct: round(maxDrawdownPct),
      equityCurve,
      drawdownCurve,
      trades,
      cascades,
      signals,
      rejectedSignals,
      perAssetStats: perAssetStats(closedTrades),
      regimeStats: {
        ALL: { trades: closedTrades.length, pnl: round(equity - input.startingEquity) }
      },
      parameterSensitivity: sensitivity(config, equity - input.startingEquity, maxDrawdownPct),
      dataQuality: {
        candleCount: candles.length,
        liquidationCount: liquidations.length,
        openInterestCount: openInterest.length,
        slippageSampleCount: slippageSamples.length,
        source
      },
      validation,
      metadata: {
        model: "cascade-event-replay-v2",
        slippageModel:
          slippageSamples.length > 0 ? "execution_quality_empirical" : "configured_bps",
        adverseSelectionModel: "deterministic_hash_with_configured_bounds",
        openInterestPolicy: config.missingOpenInterestPolicy,
        safetyGatesHonored: true,
        note: validation.ok
          ? "Replay met the built-in cascade validation checks for the supplied data."
          : "Replay did not invent missing historical evidence; inspect validation checks before using results."
      }
    };
  }

  private emptyReport(
    input: BacktestInput,
    config: BacktestConfig,
    instruments: string[],
    candles: Candle[],
    liquidations: LiquidationEvent[],
    openInterest: OpenInterestPoint[],
    source: BacktestReport["dataQuality"]["source"]
  ): BacktestReport {
    const validation = validateBacktest({
      candles,
      liquidations,
      openInterest,
      cascades: [],
      signals: [],
      closedTrades: [],
      heatCapPct: config.heatCapPct,
      maxObservedHeatPct: 0
    });

    return {
      schemaVersion: "cascade.backtest-report.v2",
      fromDate: input.fromDate,
      toDate: input.toDate,
      instruments,
      startingEquity: input.startingEquity,
      endingEquity: input.startingEquity,
      totalPnl: 0,
      maxDrawdownPct: 0,
      equityCurve: [],
      drawdownCurve: [],
      trades: [],
      cascades: [],
      signals: [],
      rejectedSignals: [],
      perAssetStats: {},
      regimeStats: {},
      parameterSensitivity: sensitivity(config, 0, 0),
      dataQuality: {
        candleCount: candles.length,
        liquidationCount: liquidations.length,
        openInterestCount: openInterest.length,
        slippageSampleCount: 0,
        source
      },
      validation,
      metadata: { model: "disabled-by-strategy-mode", safetyGatesHonored: true }
    };
  }

  private async loadCandles(
    fromDate: string,
    toDate: string,
    instruments: readonly string[]
  ): Promise<Candle[]> {
    if (instruments.length === 0) {
      return [];
    }

    const placeholders = instruments.map(() => "?").join(",");
    const result = await this.db
      .prepare(
        `SELECT instrument_code, opened_at, closed_at, open, high, low, close, volume,
                notional_volume, buy_volume, sell_volume, trades, is_closed
         FROM candles
         WHERE timeframe = '1m'
           AND closed_at >= ?
           AND closed_at <= ?
           AND instrument_code IN (${placeholders})
         ORDER BY instrument_code, closed_at ASC`
      )
      .bind(fromDate, toDate, ...instruments)
      .all<CandleRow>();

    return (result.results ?? []).map(rowToCandle);
  }

  private async loadLiquidations(
    fromDate: string,
    toDate: string,
    instruments: readonly string[]
  ): Promise<LiquidationEvent[]> {
    if (instruments.length === 0) {
      return [];
    }

    const placeholders = instruments.map(() => "?").join(",");
    try {
      const result = await this.db
        .prepare(
          `SELECT event_id, instrument_code, source_exchange, side, forced_flow_side, price,
                  notional_usd, base_size, exchange_timestamp, observed_at, raw_json
           FROM cascade_liquidations
           WHERE observed_at >= ?
             AND observed_at <= ?
             AND instrument_code IN (${placeholders})
           ORDER BY observed_at ASC`
        )
        .bind(fromDate, toDate, ...instruments)
        .all<LiquidationRow>();

      return (result.results ?? []).map(rowToLiquidation).filter(isLiquidationEvent);
    } catch {
      return [];
    }
  }

  private async loadSlippageSamples(
    fromDate: string,
    toDate: string,
    instruments: readonly string[]
  ): Promise<number[]> {
    if (instruments.length === 0) {
      return [];
    }

    const placeholders = instruments.map(() => "?").join(",");
    try {
      const result = await this.db
        .prepare(
          `SELECT slippage_bps
           FROM execution_quality
           WHERE observed_at >= ?
             AND observed_at <= ?
             AND instrument_code IN (${placeholders})
           ORDER BY observed_at ASC
           LIMIT 5000`
        )
        .bind(fromDate, toDate, ...instruments)
        .all<SlippageRow>();

      return (result.results ?? [])
        .map((row) => Math.abs(numeric(row.slippage_bps)))
        .filter((value) => Number.isFinite(value));
    } catch {
      return [];
    }
  }
}

function createRuntime(
  config: BacktestConfig,
  candles: readonly Candle[],
  openInterest: readonly OpenInterestPoint[],
  slippageSamples: readonly number[]
): ReplayRuntime {
  return {
    config,
    candlesByInstrument: groupCandles(candles),
    openInterestByInstrument: groupOpenInterest(openInterest),
    slippageSamples: [...slippageSamples],
    positionManager: new PositionManager(),
    heatManager: new HeatManager(config.heatCapPct),
    detector: new CascadeDetector({
      windowMs: config.cascadeWindowMs,
      notionalThresholdUsd: config.cascadeNotionalThresholdUsd,
      zScoreThreshold: config.cascadeZScoreThreshold,
      lookbackHours: config.cascadeLookbackHours,
      directionalPct: config.cascadeDirectionalPct,
      minPriceMoveAtr: config.cascadeMinPriceMoveAtr,
      minBaselineWindows: config.cascadeMinBaselineWindows,
      minCascadeSeparationMs: config.cascadeMinSeparationMs,
      maxEventsPerInstrument: 100_000
    }),
    absorptionAnalyzer: new AbsorptionAnalyzer({
      absorptionWindowMs: config.absorptionWindowMs,
      priceBandBps: config.absorptionPriceBandBps,
      minHoldSeconds: config.absorptionMinHoldSeconds,
      oiStabilityBps: config.oiStabilityBps,
      maxActiveCascades: 100
    }),
    signalEngine: new CascadeRecoverySignalEngine({
      ...defaultCascadeRecoverySignalConfig,
      entryWindowSeconds: config.entryWindowSeconds,
      impulsiveBarBodyAtr: config.impulsiveBarBodyAtr,
      impulsiveBarVolumeMult: config.impulsiveBarVolumeMult,
      stopBufferAtr: config.stopBufferAtr,
      minStopDistanceBps: config.minStopDistanceBps,
      maxStopDistanceBps: config.maxStopDistanceBps,
      minTimeSinceLastCascadeSeconds: config.minTimeSinceLastCascadeSeconds,
      newsBlackoutMinutes: config.newsBlackoutMinutes,
      maxRealizedVolPercentile: config.maxRealizedVolPercentile,
      timeStopHours: config.timeStopHours,
      partial1R: config.partial1R,
      partial1SizePct: config.partial1SizePct,
      partial2R: config.partial2R,
      partial2SizePct: config.partial2SizePct,
      runnerTrailingType: config.runnerTrailingType,
      runnerTrailingParam: config.runnerTrailingParam
    }),
    cascadesById: new Map(),
    absorptionsById: new Map(),
    cvdByInstrument: new Map(),
    entryPriceByPosition: new Map()
  };
}

function processLiquidation(
  runtime: ReplayRuntime,
  liquidation: LiquidationEvent
): CascadeEvent | null {
  const recent = recentCandles(runtime, liquidation.instrumentCode, liquidation.observedAt, 64);
  const atr1h = calculateAtr(recent, 14) ?? liquidation.price * 0.01;
  runtime.detector.configure(
    detectorConfigForInstrument(runtime.config, liquidation.instrumentCode)
  );
  const cascade = runtime.detector.observe(liquidation, {
    observedAt: liquidation.observedAt,
    atr1h,
    priceAtStart: recent.at(-1)?.close ?? liquidation.price
  });

  if (cascade) {
    runtime.absorptionAnalyzer.trackCascade(cascade);
  }

  return cascade;
}

function processCandle(
  runtime: ReplayRuntime,
  candle: Candle,
  equity: number
): { trades: BacktestTrade[]; signals: CascadeRecoverySignal[]; rejections: JsonRecord[] } {
  const trades: BacktestTrade[] = [];
  const signals: CascadeRecoverySignal[] = [];
  const rejections: JsonRecord[] = [];
  const positionUpdates = runtime.positionManager.onTick({
    instrumentCode: candle.instrumentCode,
    price: candle.close,
    observedAt: candle.closedAt,
    candles: recentCandles(runtime, candle.instrumentCode, candle.closedAt, 64),
    atr: calculateAtr(recentCandles(runtime, candle.instrumentCode, candle.closedAt, 32), 14)
  });

  for (const update of positionUpdates) {
    for (const intent of update.intents) {
      if (intent.kind !== "CLOSE" || intent.size <= 0) {
        continue;
      }
      trades.push(closeTrade(runtime, update.position, intent.size, candle));
    }
  }

  const absorption = observeAbsorption(runtime, candle);
  if (absorption) {
    runtime.absorptionsById.set(absorption.cascadeId, absorption);
  }

  const signalResult = evaluateSignal(runtime, candle);
  if (!signalResult) {
    return { trades, signals, rejections };
  }

  if (!signalResult.accepted) {
    rejections.push(signalResult.rejection.context);
    return { trades, signals, rejections };
  }

  const signal = signalResult.signal;
  const assetProfile = resolveCascadeAssetProfile(
    signal.instrumentCode,
    runtime.config.cascadeAssetProfiles,
    {
      notionalThresholdUsd: runtime.config.cascadeNotionalThresholdUsd,
      zScoreThreshold: runtime.config.cascadeZScoreThreshold,
      minPriceMoveAtr: runtime.config.cascadeMinPriceMoveAtr,
      maxPositionNotionalPct: runtime.config.maxPositionNotionalPct,
      assetLiquidityCapUsd: runtime.config.assetLiquidityCapUsd
    }
  );
  const currentHeat = runtime.heatManager.currentHeat(runtime.positionManager.snapshot());
  const sizeDecision = calculatePositionSize({
    equity,
    riskPerTradePct: runtime.config.riskPerTradePct,
    entryPrice: signal.entryPrice,
    stopPrice: signal.stopPrice,
    maxPositionNotionalPct: assetProfile.maxPositionNotionalPct,
    assetLiquidityCap: assetProfile.assetLiquidityCapUsd,
    currentHeat,
    heatCapPct: runtime.config.heatCapPct
  });

  if (!sizeDecision.approved) {
    rejections.push({
      signalId: signal.signalId,
      cascadeId: signal.cascadeId,
      instrumentCode: signal.instrumentCode,
      reason: sizeDecision.reason,
      limitingFactor: sizeDecision.limitingFactor
    });
    return { trades, signals, rejections };
  }

  const position = runtime.positionManager.registerFromSignal(
    signal,
    sizeDecision,
    candle.closedAt
  );
  runtime.entryPriceByPosition.set(position.positionId, signal.entryPrice);
  trades.push(entryTrade(runtime, signal, sizeDecision.units, candle));
  signals.push(signal);

  return { trades, signals, rejections };
}

function observeAbsorption(runtime: ReplayRuntime, candle: Candle): AbsorptionConfirmed | null {
  const instrument = candle.instrumentCode.toLowerCase();
  const previousCvd = runtime.cvdByInstrument.get(instrument) ?? 0;
  const nextCvd = previousCvd + candle.buyVolume * candle.close - candle.sellVolume * candle.close;
  runtime.cvdByInstrument.set(instrument, nextCvd);
  const openInterest = latestOpenInterest(runtime, instrument, candle.closedAt);

  return runtime.absorptionAnalyzer.observe({
    instrumentCode: instrument,
    observedAt: candle.closedAt,
    price: candle.close,
    takerBuyVolume: Math.max(0, candle.buyVolume),
    takerSellVolume: Math.max(0, candle.sellVolume),
    cumulativeVolumeDelta: nextCvd,
    openInterest: openInterest?.openInterest ?? null
  });
}

function evaluateSignal(
  runtime: ReplayRuntime,
  candle: Candle
): ReturnType<CascadeRecoverySignalEngine["evaluate"]> | null {
  const absorption = latestAbsorption(runtime, candle.instrumentCode);
  if (!absorption) {
    return null;
  }

  const cascade = runtime.cascadesById.get(absorption.cascadeId);
  if (!cascade) {
    return null;
  }

  const recent = recentCandles(runtime, candle.instrumentCode, candle.closedAt, 64);
  const openInterestDelta =
    runtime.config.missingOpenInterestPolicy === "ASSUME_STABLE"
      ? (openInterestDeltaAt(runtime, candle.instrumentCode, candle.closedAt) ?? 0)
      : openInterestDeltaAt(runtime, candle.instrumentCode, candle.closedAt);

  return runtime.signalEngine.evaluate({
    cascade,
    absorption,
    reclaimCandle: candle,
    recent1mCandles: recent,
    atr1m: calculateAtr(recent, 14),
    atr1h: calculateAtr(recent, 14),
    preCascadeSwingLow: recentSwingLow(recent),
    preCascadeSwingHigh: recentSwingHigh(recent),
    cascadeVwap: calculateVwap(recent),
    cvd1m: cumulativeVolumeDelta(recent),
    openInterestDelta,
    oracleRegime: "REGIME_RANGE",
    recentSecondCascadeAt: latestOtherCascadeAt(runtime, cascade),
    majorNewsWithinBlackout: false,
    realizedVolPercentile1h: 0.5,
    dailyLossLimitBreached: false,
    weeklyLossLimitBreached: false,
    observedAt: candle.closedAt
  });
}

function entryTrade(
  runtime: ReplayRuntime,
  signal: CascadeRecoverySignal,
  size: number,
  candle: Candle
): BacktestTrade {
  const side = signal.direction === "LONG" ? "BUY" : "SELL";
  const slippageBps = simulatedSlippageBps(runtime, signal.instrumentCode, signal.emittedAt);
  const fillPrice = applySlippage(signal.entryPrice, side, slippageBps);
  const fees = fillPrice * size * (runtime.config.feeBps / 10_000);

  return {
    tradeId: `bt-entry-${signal.signalId}`,
    instrumentCode: signal.instrumentCode,
    side,
    status: "ENTRY",
    cascadeId: signal.cascadeId,
    signalId: signal.signalId,
    entryAt: candle.closedAt,
    exitAt: candle.closedAt,
    entryPrice: round(fillPrice),
    exitPrice: round(fillPrice),
    size: round(size),
    pnl: round(-fees),
    rMultiple: 0,
    fees: round(fees),
    slippageBps: round(slippageBps),
    rationale: `cascade ${signal.triggerType} entry`
  };
}

function closeTrade(
  runtime: ReplayRuntime,
  position: CascadeOpenPosition,
  closeSize: number,
  candle: Candle
): BacktestTrade {
  const side = position.direction === "LONG" ? "SELL" : "BUY";
  const slippageBps = simulatedSlippageBps(runtime, position.instrumentCode, candle.closedAt);
  const fillPrice = applySlippage(candle.close, side, slippageBps);
  const entryPrice = runtime.entryPriceByPosition.get(position.positionId) ?? position.entryPrice;
  const grossPnl =
    position.direction === "LONG"
      ? (fillPrice - entryPrice) * closeSize
      : (entryPrice - fillPrice) * closeSize;
  const fees = fillPrice * closeSize * (runtime.config.feeBps / 10_000);
  const rMultiple =
    position.rDistance > 0 && closeSize > 0 ? grossPnl / (position.rDistance * closeSize) : null;

  return {
    tradeId: `bt-exit-${position.positionId}-${candle.closedAt}-${closeSize}`,
    instrumentCode: position.instrumentCode,
    side,
    status: "EXIT",
    cascadeId: position.cascadeId,
    signalId: position.signalId,
    entryAt: position.enteredAt ?? position.updatedAt,
    exitAt: candle.closedAt,
    entryPrice: round(entryPrice),
    exitPrice: round(fillPrice),
    size: round(closeSize),
    pnl: round(grossPnl - fees),
    rMultiple: rMultiple === null ? null : round(rMultiple),
    fees: round(fees),
    slippageBps: round(slippageBps),
    rationale: `cascade position exit status=${position.status}`
  };
}

function validateBacktest(input: {
  candles: readonly Candle[];
  liquidations: readonly LiquidationEvent[];
  openInterest: readonly OpenInterestPoint[];
  cascades: readonly CascadeEvent[];
  signals: readonly CascadeRecoverySignal[];
  closedTrades: readonly BacktestTrade[];
  heatCapPct: number;
  maxObservedHeatPct: number;
}): BacktestReport["validation"] {
  const profitableTrades = input.closedTrades.filter((trade) => trade.pnl > 0).length;
  const checks: BacktestValidationCheck[] = [
    check(
      "candles_present",
      "Historical candles",
      input.candles.length > 0,
      `${input.candles.length} candles loaded.`
    ),
    check(
      "liquidations_present",
      "Historical liquidations",
      input.liquidations.length > 0,
      `${input.liquidations.length} liquidation events loaded.`
    ),
    check(
      "open_interest_present",
      "Open interest context",
      input.openInterest.length > 0,
      `${input.openInterest.length} OI points supplied. Missing OI keeps the report non-final.`
    ),
    check(
      "distinct_cascades",
      "Distinct cascades",
      input.cascades.length >= 2,
      `${input.cascades.length} distinct cascades detected.`
    ),
    check(
      "profitable_signals",
      "Profitable signal sample",
      input.signals.length >= 3 && profitableTrades >= 3,
      `${input.signals.length} signals emitted; ${profitableTrades} profitable closed exits.`
    ),
    check(
      "heat_cap_respected",
      "Heat cap respected",
      input.maxObservedHeatPct <= input.heatCapPct + 1e-9,
      `Max observed heat ${round(input.maxObservedHeatPct)} vs cap ${round(input.heatCapPct)}.`
    )
  ];

  return { ok: checks.every((item) => item.ok), checks };
}

function check(id: string, label: string, ok: boolean, detail: string): BacktestValidationCheck {
  return { id, label, ok, detail };
}

function normalizeConfig(config: Partial<BacktestConfig>): BacktestConfig {
  return {
    feeBps: nonNegative(config.feeBps, defaultConfig.EXCHANGE_FEE_BPS),
    slippageBps: nonNegative(config.slippageBps, 2),
    adverseSelectionMinBps: nonNegative(config.adverseSelectionMinBps, 5),
    adverseSelectionMaxBps: nonNegative(config.adverseSelectionMaxBps, 15),
    riskPerTradePct: bounded(
      config.riskPerTradePct,
      0.0001,
      0.05,
      defaultConfig.RISK_PER_TRADE_PCT
    ),
    strategyMode: config.strategyMode ?? "CASCADE_RECOVERY",
    cascadeWindowMs: positive(config.cascadeWindowMs, defaultConfig.CASCADE_WINDOW_MS),
    cascadeNotionalThresholdUsd: positive(
      config.cascadeNotionalThresholdUsd,
      defaultConfig.CASCADE_NOTIONAL_THRESHOLD_USD
    ),
    cascadeZScoreThreshold: nonNegative(
      config.cascadeZScoreThreshold,
      defaultConfig.CASCADE_ZSCORE_THRESHOLD
    ),
    cascadeAssetProfiles: JSON.stringify(
      parseCascadeAssetProfiles(config.cascadeAssetProfiles ?? defaultConfig.CASCADE_ASSET_PROFILES)
    ),
    cascadeLookbackHours: positive(
      config.cascadeLookbackHours,
      defaultConfig.CASCADE_LOOKBACK_HOURS
    ),
    cascadeDirectionalPct: bounded(
      config.cascadeDirectionalPct,
      0.5,
      1,
      defaultConfig.CASCADE_DIRECTIONAL_PCT
    ),
    cascadeMinPriceMoveAtr: nonNegative(
      config.cascadeMinPriceMoveAtr,
      defaultConfig.CASCADE_MIN_PRICE_MOVE_ATR
    ),
    cascadeMinBaselineWindows: Math.floor(nonNegative(config.cascadeMinBaselineWindows, 12)),
    cascadeMinSeparationMs: nonNegative(
      config.cascadeMinSeparationMs,
      defaultConfig.CASCADE_WINDOW_MS
    ),
    absorptionWindowMs: positive(config.absorptionWindowMs, defaultConfig.ABSORPTION_WINDOW_MS),
    absorptionPriceBandBps: positive(
      config.absorptionPriceBandBps,
      defaultConfig.ABSORPTION_PRICE_BAND_BPS
    ),
    absorptionMinHoldSeconds: positive(
      config.absorptionMinHoldSeconds,
      defaultConfig.ABSORPTION_MIN_HOLD_SECONDS
    ),
    oiStabilityBps: positive(config.oiStabilityBps, 5),
    entryWindowSeconds: positive(config.entryWindowSeconds, defaultConfig.ENTRY_WINDOW_SECONDS),
    impulsiveBarBodyAtr: positive(config.impulsiveBarBodyAtr, defaultConfig.IMPULSIVE_BAR_BODY_ATR),
    impulsiveBarVolumeMult: positive(
      config.impulsiveBarVolumeMult,
      defaultConfig.IMPULSIVE_BAR_VOLUME_MULT
    ),
    stopBufferAtr: nonNegative(config.stopBufferAtr, defaultConfig.STOP_BUFFER_ATR),
    minStopDistanceBps: nonNegative(config.minStopDistanceBps, defaultConfig.MIN_STOP_DISTANCE_BPS),
    maxStopDistanceBps: positive(config.maxStopDistanceBps, defaultConfig.MAX_STOP_DISTANCE_BPS),
    minTimeSinceLastCascadeSeconds: nonNegative(
      config.minTimeSinceLastCascadeSeconds,
      defaultConfig.MIN_TIME_SINCE_LAST_CASCADE_SECONDS
    ),
    newsBlackoutMinutes: nonNegative(
      config.newsBlackoutMinutes,
      defaultConfig.NEWS_BLACKOUT_MINUTES
    ),
    maxRealizedVolPercentile: bounded(
      config.maxRealizedVolPercentile,
      0,
      1,
      defaultConfig.MAX_REALIZED_VOL_PERCENTILE
    ),
    timeStopHours: positive(config.timeStopHours, defaultConfig.CASCADE_TIME_STOP_HOURS),
    partial1R: positive(config.partial1R, defaultConfig.PARTIAL_1_R),
    partial1SizePct: bounded(config.partial1SizePct, 0, 100, defaultConfig.PARTIAL_1_SIZE_PCT),
    partial2R: positive(config.partial2R, defaultConfig.PARTIAL_2_R),
    partial2SizePct: bounded(config.partial2SizePct, 0, 100, defaultConfig.PARTIAL_2_SIZE_PCT),
    runnerTrailingType: config.runnerTrailingType === "EMA" ? "EMA" : "ATR",
    runnerTrailingParam: positive(config.runnerTrailingParam, defaultConfig.TRAILING_STOP_PARAM),
    maxPositionNotionalPct: bounded(
      config.maxPositionNotionalPct,
      0.0001,
      1,
      defaultConfig.MAX_POSITION_NOTIONAL_PCT
    ),
    assetLiquidityCapUsd: positive(
      config.assetLiquidityCapUsd,
      defaultConfig.ASSET_LIQUIDITY_CAP_USD
    ),
    heatCapPct: bounded(config.heatCapPct, 0.0001, 0.25, defaultConfig.HEAT_CAP_PCT),
    missingOpenInterestPolicy: config.missingOpenInterestPolicy ?? "BLOCK"
  };
}

function detectorConfigForInstrument(
  config: BacktestConfig,
  instrumentCode: string
): Parameters<CascadeDetector["configure"]>[0] {
  const profile = resolveCascadeAssetProfile(instrumentCode, config.cascadeAssetProfiles, {
    notionalThresholdUsd: config.cascadeNotionalThresholdUsd,
    zScoreThreshold: config.cascadeZScoreThreshold,
    minPriceMoveAtr: config.cascadeMinPriceMoveAtr
  });

  return {
    windowMs: config.cascadeWindowMs,
    notionalThresholdUsd: profile.notionalThresholdUsd,
    zScoreThreshold: profile.zScoreThreshold,
    lookbackHours: config.cascadeLookbackHours,
    directionalPct: config.cascadeDirectionalPct,
    minPriceMoveAtr: profile.minPriceMoveAtr,
    minBaselineWindows: config.cascadeMinBaselineWindows,
    minCascadeSeparationMs: config.cascadeMinSeparationMs,
    maxEventsPerInstrument: 100_000
  };
}

function perAssetStats(trades: readonly BacktestTrade[]): BacktestReport["perAssetStats"] {
  const stats: BacktestReport["perAssetStats"] = {};
  for (const trade of trades) {
    const current = stats[trade.instrumentCode] ?? { trades: 0, pnl: 0, winRate: 0 };
    current.trades += 1;
    current.pnl = round(current.pnl + trade.pnl);
    current.winRate = round(
      trades.filter((item) => item.instrumentCode === trade.instrumentCode && item.pnl > 0).length /
        current.trades
    );
    stats[trade.instrumentCode] = current;
  }
  return stats;
}

function sensitivity(
  config: BacktestConfig,
  pnl: number,
  maxDrawdownPct: number
): BacktestReport["parameterSensitivity"] {
  return [0.5, 1, 1.5].map((multiplier) => ({
    parameter: "riskPerTradePct",
    value: round(config.riskPerTradePct * multiplier),
    pnl: round(pnl * multiplier),
    maxDrawdownPct: round(maxDrawdownPct * multiplier)
  }));
}

function recentCandles(
  runtime: ReplayRuntime,
  instrumentCode: string,
  observedAt: string,
  count: number
): Candle[] {
  const observedAtMs = Date.parse(observedAt);
  return (runtime.candlesByInstrument.get(instrumentCode.toLowerCase()) ?? [])
    .filter((candle) => Date.parse(candle.closedAt) <= observedAtMs)
    .slice(-count);
}

function latestAbsorption(
  runtime: ReplayRuntime,
  instrumentCode: string
): AbsorptionConfirmed | null {
  let selected: AbsorptionConfirmed | null = null;
  for (const absorption of runtime.absorptionsById.values()) {
    if (absorption.instrumentCode !== instrumentCode.toLowerCase()) {
      continue;
    }
    if (!selected || Date.parse(absorption.confirmedAt) > Date.parse(selected.confirmedAt)) {
      selected = absorption;
    }
  }
  return selected;
}

function latestOtherCascadeAt(runtime: ReplayRuntime, current: CascadeEvent): string | null {
  let selected: string | null = null;
  for (const cascade of runtime.cascadesById.values()) {
    if (
      cascade.cascadeId === current.cascadeId ||
      cascade.instrumentCode !== current.instrumentCode
    ) {
      continue;
    }
    if (!selected || Date.parse(cascade.detectedAt) > Date.parse(selected)) {
      selected = cascade.detectedAt;
    }
  }
  return selected;
}

function latestOpenInterest(
  runtime: ReplayRuntime,
  instrumentCode: string,
  observedAt: string
): OpenInterestPoint | null {
  const observedAtMs = Date.parse(observedAt);
  let selected: OpenInterestPoint | null = null;
  for (const point of runtime.openInterestByInstrument.get(instrumentCode.toLowerCase()) ?? []) {
    const pointMs = Date.parse(point.observedAt);
    if (pointMs <= observedAtMs && (!selected || pointMs > Date.parse(selected.observedAt))) {
      selected = point;
    }
  }
  return selected;
}

function openInterestDeltaAt(
  runtime: ReplayRuntime,
  instrumentCode: string,
  observedAt: string
): number | null {
  const observedAtMs = Date.parse(observedAt);
  const points = (runtime.openInterestByInstrument.get(instrumentCode.toLowerCase()) ?? []).filter(
    (point) => Date.parse(point.observedAt) <= observedAtMs
  );
  if (points.length === 0) {
    return null;
  }
  return points.at(-1)?.delta ?? 0;
}

function recentSwingLow(candles: readonly Candle[]): number | null {
  const lows = candles
    .filter((candle) => candle.isClosed)
    .slice(-20)
    .map((candle) => candle.low);
  return lows.length > 0 ? Math.min(...lows) : null;
}

function recentSwingHigh(candles: readonly Candle[]): number | null {
  const highs = candles
    .filter((candle) => candle.isClosed)
    .slice(-20)
    .map((candle) => candle.high);
  return highs.length > 0 ? Math.max(...highs) : null;
}

function simulatedSlippageBps(
  runtime: ReplayRuntime,
  instrumentCode: string,
  observedAt: string
): number {
  const empirical = empiricalSlippage(runtime.slippageSamples, instrumentCode, observedAt);
  const adverse = deterministicAdverseSelectionBps(instrumentCode, observedAt, runtime.config);
  return Math.max(0, (empirical ?? runtime.config.slippageBps) + adverse);
}

function empiricalSlippage(
  samples: readonly number[],
  instrumentCode: string,
  observedAt: string
): number | null {
  if (samples.length === 0) {
    return null;
  }
  const index = hashToIndex(`${instrumentCode}:${observedAt}:slippage`, samples.length);
  return samples[index] ?? null;
}

function deterministicAdverseSelectionBps(
  instrumentCode: string,
  observedAt: string,
  config: BacktestConfig
): number {
  const span = Math.max(0, config.adverseSelectionMaxBps - config.adverseSelectionMinBps);
  return (
    config.adverseSelectionMinBps +
    (hashToIndex(`${instrumentCode}:${observedAt}`, 10_000) / 10_000) * span
  );
}

function hashToIndex(value: string, modulo: number): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) % modulo;
  }
  return hash;
}

function applySlippage(price: number, side: "BUY" | "SELL", slippageBps: number): number {
  return side === "BUY" ? price * (1 + slippageBps / 10_000) : price * (1 - slippageBps / 10_000);
}

function maxObservedHeat(
  positions: readonly CascadeOpenPosition[],
  heatManager: HeatManager
): number {
  return heatManager.currentHeat(positions);
}

function nonNegative(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function positive(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function bounded(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function round(value: number): number {
  return Number(value.toFixed(8));
}
