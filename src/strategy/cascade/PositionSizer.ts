import type { PositionSizeDecision, PositionSizeInput } from "./types";

const PRICE_PRECISION = 8;

export function calculatePositionSize(input: PositionSizeInput): PositionSizeDecision {
  const equity = input.equity;
  const riskPerTradePct = input.riskPerTradePct;
  const entryPrice = input.entryPrice;
  const stopPrice = input.stopPrice;
  const maxPositionNotionalPct = input.maxPositionNotionalPct;
  const assetLiquidityCap = input.assetLiquidityCap;
  const currentHeat = input.currentHeat;
  const heatCapPct = input.heatCapPct;
  const stopDistance = Math.abs(entryPrice - stopPrice);

  if (
    !isPositive(equity) ||
    !isPositive(entryPrice) ||
    !isPositive(stopDistance) ||
    !isFiniteNonNegative(riskPerTradePct) ||
    !isFiniteNonNegative(maxPositionNotionalPct) ||
    !isFiniteNonNegative(assetLiquidityCap) ||
    !isFiniteNonNegative(currentHeat) ||
    !isFiniteNonNegative(heatCapPct)
  ) {
    return emptyDecision("INVALID_INPUT", "Invalid sizing input.", {
      riskUnits: 0,
      notionalUnits: 0,
      liquidityUnits: 0,
      heatUnits: 0
    });
  }

  const remainingHeatPct = Math.max(0, heatCapPct - currentHeat);
  if (remainingHeatPct <= 0) {
    return emptyDecision("HEAT", "Portfolio heat cap is already exhausted.", {
      riskUnits: 0,
      notionalUnits: 0,
      liquidityUnits: 0,
      heatUnits: 0
    });
  }

  const riskUnits = (equity * riskPerTradePct) / stopDistance;
  const notionalUnits = (equity * maxPositionNotionalPct) / entryPrice;
  const liquidityUnits = assetLiquidityCap / entryPrice;
  const heatUnits = (equity * remainingHeatPct) / stopDistance;
  const bounds = { riskUnits, notionalUnits, liquidityUnits, heatUnits };
  const selectedUnits = Math.min(riskUnits, notionalUnits, liquidityUnits, heatUnits);

  if (!isPositive(selectedUnits)) {
    return emptyDecision(
      "INVALID_INPUT",
      "No positive position size is available after applying all caps.",
      bounds
    );
  }

  const limitingFactor = findLimitingFactor(bounds, selectedUnits);
  const units = round(selectedUnits);
  const notionalUsd = round(units * entryPrice);
  const riskUsd = round(units * stopDistance);
  const riskPct = round(riskUsd / equity);
  const heatAfterPct = round(currentHeat + riskPct);

  return {
    approved: true,
    units,
    notionalUsd,
    riskUsd,
    riskPct,
    heatAfterPct,
    limitingFactor,
    reason: "Position size approved.",
    bounds: {
      riskUnits: round(riskUnits),
      notionalUnits: round(notionalUnits),
      liquidityUnits: round(liquidityUnits),
      heatUnits: round(heatUnits)
    }
  };
}

function emptyDecision(
  limitingFactor: PositionSizeDecision["limitingFactor"],
  reason: string,
  bounds: PositionSizeDecision["bounds"]
): PositionSizeDecision {
  return {
    approved: false,
    units: 0,
    notionalUsd: 0,
    riskUsd: 0,
    riskPct: 0,
    heatAfterPct: 0,
    limitingFactor,
    reason,
    bounds
  };
}

function findLimitingFactor(
  bounds: PositionSizeDecision["bounds"],
  selectedUnits: number
): PositionSizeDecision["limitingFactor"] {
  if (selectedUnits === bounds.heatUnits) {
    return "HEAT";
  }
  if (selectedUnits === bounds.liquidityUnits) {
    return "LIQUIDITY";
  }
  if (selectedUnits === bounds.notionalUnits) {
    return "NOTIONAL";
  }
  return "RISK";
}

function round(value: number): number {
  return Number(value.toFixed(PRICE_PRECISION));
}

function isPositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function isFiniteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}
