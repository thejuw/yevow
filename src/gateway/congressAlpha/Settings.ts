import type { JsonRecord } from "../../types";
import {
  DEFAULT_BANKROLL_USD,
  DEFAULT_LOOKBACK_DAYS,
  DEFAULT_MAX_POSITIONS,
  DEFAULT_MAX_WEIGHT_PCT,
  DEFAULT_MIN_SCORE,
  clampPositive
} from "./Common";

export interface CongressAlphaRunOptions {
  bankroll: number;
  maxPositions: number;
  minScore: number;
  maxWeightPct: number;
  lookbackDays: number;
}

export type CongressAlphaSettings = CongressAlphaRunOptions & { autoRunEnabled: boolean };

export function normalizeAlphaSettings(input: JsonRecord): CongressAlphaSettings {
  return {
    bankroll: clampPositive(input.bankroll, DEFAULT_BANKROLL_USD, 100, 10_000_000),
    maxPositions: Math.floor(clampPositive(input.maxPositions, DEFAULT_MAX_POSITIONS, 1, 50)),
    minScore: clampPositive(input.minScore, DEFAULT_MIN_SCORE, 1, 100),
    maxWeightPct: clampPositive(input.maxWeightPct, DEFAULT_MAX_WEIGHT_PCT, 1, 50),
    lookbackDays: Math.floor(clampPositive(input.lookbackDays, DEFAULT_LOOKBACK_DAYS, 1, 730)),
    autoRunEnabled: input.autoRunEnabled !== false
  };
}
