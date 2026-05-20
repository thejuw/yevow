import type { GlobalRiskConfig, JsonRecord } from "../../../types";

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
