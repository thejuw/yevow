import { CASCADE_PAPER_ARMED_AT_KEY } from "../../../TradingEngineConstants";
import { isShadowMode } from "../../../utils/CitadelProtocol";
import type { Env, GlobalRiskConfig, JsonRecord } from "../../../types";
import { recordTradingStorageWriteFailureForTargetOrHandler } from "../state/StorageWriteGuard";

export interface CascadePaperModeArmingInput {
  readonly observedAt: string;
  readonly cachedConfig: Pick<GlobalRiskConfig, "STRATEGY_MODE" | "TRADING_ENABLED">;
  readonly shadowMode: boolean;
}

export interface CascadePaperModeArmingHandlers {
  readonly getArmedAt: () => Promise<string | null>;
  readonly putArmedAt: (observedAt: string) => Promise<void>;
  readonly warnArmed: (metadata: JsonRecord) => void;
  readonly handleError: (error: unknown) => void;
}

export interface CascadePaperModeArmingTarget {
  readonly cachedConfig: Pick<GlobalRiskConfig, "STRATEGY_MODE" | "TRADING_ENABLED">;
  readonly env: Pick<Env, "CONFIG_STORE" | "SHADOW_MODE">;
  readonly logger: {
    warn(eventType: string, message: string, metadata?: JsonRecord): void;
  };
  handleStorageWriteFailure?(reason: string, error: unknown): void;
}

export async function ensureCascadePaperModeArmedRuntime(
  input: CascadePaperModeArmingInput,
  handlers: CascadePaperModeArmingHandlers
): Promise<boolean> {
  try {
    const existing = await handlers.getArmedAt();
    if (existing) {
      return false;
    }

    await handlers.putArmedAt(input.observedAt);
    handlers.warnArmed({
      strategyMode: input.cachedConfig.STRATEGY_MODE,
      tradingEnabled: input.cachedConfig.TRADING_ENABLED,
      shadowMode: input.shadowMode,
      observedAt: input.observedAt
    });
    return true;
  } catch (error) {
    handlers.handleError(error);
    return false;
  }
}

export function ensureCascadePaperModeArmedForTarget(
  observedAt: string,
  target: CascadePaperModeArmingTarget
): Promise<boolean> {
  return ensureCascadePaperModeArmedRuntime(
    {
      observedAt,
      cachedConfig: target.cachedConfig,
      shadowMode: isShadowMode(target.env)
    },
    {
      getArmedAt: () => target.env.CONFIG_STORE.get(CASCADE_PAPER_ARMED_AT_KEY),
      putArmedAt: (armedAt) => target.env.CONFIG_STORE.put(CASCADE_PAPER_ARMED_AT_KEY, armedAt),
      warnArmed: (metadata) => {
        target.logger.warn(
          "CASCADE_PAPER_MODE_ARMED",
          "Cascade recovery paper-mode clock started",
          metadata
        );
      },
      handleError: (error) => {
        recordTradingStorageWriteFailureForTargetOrHandler(
          target,
          "CASCADE_PAPER_MODE_ARMING",
          error
        );
      }
    }
  );
}
