import type {
  EngineState,
  Env,
  GlobalRiskConfig,
  JsonRecord,
  MacroBias,
  MarketTick
} from "../../../types";
import { isShadowMode } from "../../../utils/CitadelProtocol";
import {
  aggregateQuoteState,
  defaultAssetQuoteStates,
  normalizeAssetQuoteStates
} from "./AssetStateRuntime";
import { normalizePaperBankroll } from "./EngineStateDefaults";
import {
  applyShadowModeAutoResumeSideEffects,
  shadowModeAutoResumeArtifacts,
  shouldAutoResumeShadowMode
} from "./TickStateRuntime";

export interface TradingShadowModeAutoResumeInput {
  readonly tick: MarketTick;
  readonly shadowReplay: boolean;
  readonly env: Env;
  readonly config: GlobalRiskConfig;
  readonly macroBias: MacroBias;
  readonly currentState: EngineState;
}

export interface TradingShadowModeAutoResumeHandlers {
  readonly applyState: (state: EngineState) => void;
  readonly clearKillSwitchLogged: () => void;
  readonly warnResume: (metadata: JsonRecord) => void;
  readonly publishResume: (payload: JsonRecord) => void;
}

export function maybeResumeTradingShadowMode(
  input: TradingShadowModeAutoResumeInput,
  handlers: TradingShadowModeAutoResumeHandlers
): void {
  if (
    !shouldAutoResumeShadowMode({
      shadowReplay: input.shadowReplay,
      shadowMode: isShadowMode(input.env),
      tradingEnabled: input.config.TRADING_ENABLED,
      mode: input.currentState.mode
    })
  ) {
    return;
  }

  const resumedAt = new Date().toISOString();
  const assetQuoteStates = normalizeAssetQuoteStates(
    defaultAssetQuoteStates(input.config, input.macroBias, resumedAt),
    input.config,
    input.macroBias,
    resumedAt
  );

  const artifacts = shadowModeAutoResumeArtifacts({
    currentState: input.currentState,
    normalizedBankroll: normalizePaperBankroll(input.currentState.bankroll, input.env, resumedAt),
    assetQuoteStates,
    quoteState: aggregateQuoteState(assetQuoteStates, input.currentState.quoteState, resumedAt),
    observedAt: resumedAt,
    tick: input.tick,
    configVersion: input.config.version
  });

  applyShadowModeAutoResumeSideEffects(artifacts, handlers);
}
