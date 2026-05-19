import { TARGET_ASSET_MATRIX } from "../../../TradingEngineConstants";
import {
  finiteMetric,
  isInstrumentSelectedByMoltworker,
  isQuoteSuspendedAt,
  quoteStateForInstrumentState
} from "../../../TradingEngineRuntimeHelpers";
import type {
  AssetRuntimeState,
  EngineState,
  InternalOrderBook,
  MacroBias,
  ProfilerState
} from "../../../types";

export interface AssetMatrixRuntimeInput {
  readonly observedAt: string;
  readonly latestOracle: EngineState["oracle"];
  readonly profilerStates: Record<string, ProfilerState>;
  readonly assetQuoteStates: EngineState["assetQuoteStates"];
  readonly fallbackQuoteState: EngineState["quoteState"];
  readonly macroBias: MacroBias;
  readonly equity: number;
  readonly maxPositionPct: number;
  readonly findBestAssetBook: (instrumentCode: string) => InternalOrderBook | undefined;
  readonly profilerStateForInstrument: (instrumentCode: string) => ProfilerState;
}

export function calculateAssetMatrix(
  input: AssetMatrixRuntimeInput
): Record<string, AssetRuntimeState> {
  const activeWeights: Record<string, number> = {};
  let totalWeight = 0;

  for (const asset of TARGET_ASSET_MATRIX) {
    const oracleState = oracleStateForInstrument(input.latestOracle, asset.instrumentCode);
    const volatility = Math.max(0.000001, finiteMetric(oracleState?.volatility ?? 0.01, 0.01));
    const selectedByMoltworker = isInstrumentSelectedByMoltworker(
      asset.instrumentCode,
      input.macroBias
    );
    const book = input.findBestAssetBook(asset.instrumentCode);
    const quoteState = quoteStateForInstrumentState(
      input.assetQuoteStates,
      asset.instrumentCode,
      input.fallbackQuoteState
    );
    const active =
      selectedByMoltworker &&
      Boolean(book?.isSynced) &&
      !isQuoteSuspendedAt(quoteState, input.observedAt);
    const weight = active ? 1 / volatility : 0;
    activeWeights[asset.instrumentCode] = weight;
    totalWeight += weight;
  }

  const equity = Math.max(input.equity, 0);

  return Object.fromEntries(
    TARGET_ASSET_MATRIX.map((asset) => {
      const book = input.findBestAssetBook(asset.instrumentCode);
      const oracleState = oracleStateForInstrument(input.latestOracle, asset.instrumentCode);
      const profilerState =
        input.profilerStates[asset.instrumentCode] ??
        input.profilerStateForInstrument(asset.instrumentCode);
      const allocation = totalWeight > 0 ? activeWeights[asset.instrumentCode] / totalWeight : 0;
      const selectedByMoltworker = isInstrumentSelectedByMoltworker(
        asset.instrumentCode,
        input.macroBias
      );
      const quoteState = quoteStateForInstrumentState(
        input.assetQuoteStates,
        asset.instrumentCode,
        input.fallbackQuoteState
      );
      const quoteSuspended = isQuoteSuspendedAt(quoteState, input.observedAt);
      const quoteEligible =
        selectedByMoltworker &&
        Boolean(book?.isSynced) &&
        !quoteSuspended &&
        profilerState.toxicityState !== "CRITICAL";

      return [
        asset.instrumentCode,
        {
          instrumentCode: asset.instrumentCode,
          coin: asset.coin,
          selectedByMoltworker,
          active: quoteEligible,
          isSynced: Boolean(book?.isSynced),
          lastSequence: book?.lastSequence ?? null,
          midPrice: book?.midPrice ?? null,
          volatility: finiteMetric(oracleState?.volatility ?? 0.01, 0.01),
          capitalAllocationPct: roundRuntimeMetric(allocation, 8),
          maxNotional: roundRuntimeMetric(equity * input.maxPositionPct * allocation, 8),
          toxicityState: profilerState.toxicityState,
          amVpin: profilerState.amVpinScore,
          obi: profilerState.obi,
          quoteStatus: quoteSuspended ? "SUSPENDED" : "ACTIVE",
          quoteReason: quoteState.reason,
          quoteSuspendedUntil: quoteState.suspendedUntil,
          quoteEligible,
          lastQuoteAt: quoteState.lastQuote?.createdAt ?? quoteState.updatedAt,
          updatedAt: book?.updatedAt ?? input.observedAt
        } satisfies AssetRuntimeState
      ];
    })
  );
}

function oracleStateForInstrument(
  oracle: EngineState["oracle"],
  instrumentCode: string
): EngineState["oracle"] | undefined {
  return oracle.instrumentCode === instrumentCode
    ? oracle
    : oracle.instrumentStates?.[instrumentCode];
}

function roundRuntimeMetric(value: number, decimals: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  const multiplier = 10 ** decimals;
  return Math.round(value * multiplier) / multiplier;
}
