import {
  impliedProb,
  previewPayout,
  settleParimutuel,
  type SettlementEntry,
  type Side,
  type SideTotals
} from "../engine/dotcast";
import { json, readJsonBody } from "./ResponseHelpers";

interface DotCastPreviewRequest {
  pools?: Partial<SideTotals>;
  side?: unknown;
  amount?: unknown;
  rake?: unknown;
}

interface DotCastSettlementSimulationRequest {
  entries?: unknown;
  outcome?: unknown;
  rake?: unknown;
}

export function readDotCastHealth(): Response {
  return json({
    ok: true,
    product: "dotCast",
    engine: "live-parimutuel",
    milestones: {
      p0: "parimutuel-core-ready",
      p1: "pool-lifecycle-core-ready",
      persistence: "pending-durable-object-migration",
      settlementRail: "not-enabled"
    },
    routes: [
      "GET /api/dotcast/health",
      "POST /api/dotcast/preview",
      "POST /api/dotcast/settlement/simulate"
    ]
  });
}

export async function previewDotCastOdds(request: Request): Promise<Response> {
  try {
    const body = await readJsonBody<DotCastPreviewRequest>(request);
    const pools = parseSideTotals(body?.pools);
    const side = parseSide(body?.side);
    const amount = parseMinorUnits(body?.amount, "amount");
    const rake = parseRake(body?.rake);
    const odds = impliedProb(pools);

    return json({
      ok: true,
      pools,
      odds,
      preview: {
        side,
        amount,
        payout: previewPayout(pools, side, amount, rake)
      },
      rake
    });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : "Invalid request" }, 400);
  }
}

export async function simulateDotCastSettlement(request: Request): Promise<Response> {
  try {
    const body = await readJsonBody<DotCastSettlementSimulationRequest>(request);
    const entries = parseEntries(body?.entries);
    const outcome = parseSide(body?.outcome);
    const rake = parseRake(body?.rake);
    const result = settleParimutuel(entries, outcome, rake);
    const payoutTotal = result.payouts.reduce((sum, payout) => sum + payout.payout, 0);

    return json({
      ok: true,
      result,
      conservation: {
        payoutTotal,
        rakeAmount: result.rakeAmount,
        totalStaked: result.totalStaked,
        conserved: payoutTotal + result.rakeAmount === result.totalStaked
      }
    });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : "Invalid request" }, 400);
  }
}

function parseEntries(value: unknown): SettlementEntry[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("entries must be a non-empty array");
  }

  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object") {
      throw new Error(`entries[${index}] must be an object`);
    }

    const record = candidate as Record<string, unknown>;
    const id = typeof record.id === "string" && record.id.length > 0 ? record.id : `entry-${index}`;

    return {
      id,
      side: parseSide(record.side),
      amount: parseMinorUnits(record.amount, `entries[${index}].amount`),
      placedAt: typeof record.placedAt === "string" ? record.placedAt : undefined
    };
  });
}

function parseSideTotals(value: DotCastPreviewRequest["pools"]): SideTotals {
  return {
    yes: parseMinorUnits(value?.yes ?? 0, "pools.yes", true),
    no: parseMinorUnits(value?.no ?? 0, "pools.no", true)
  };
}

function parseSide(value: unknown): Side {
  if (value === "yes" || value === "no") {
    return value;
  }

  throw new Error("side/outcome must be yes or no");
}

function parseMinorUnits(value: unknown, label: string, allowZero = false): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    (!allowZero && value === 0)
  ) {
    throw new Error(`${label} must be ${allowZero ? "a non-negative" : "a positive"} integer minor-unit amount`);
  }

  return value;
}

function parseRake(value: unknown): number {
  const rake = value ?? 0;

  if (typeof rake !== "number" || !Number.isFinite(rake) || rake < 0 || rake > 1) {
    throw new Error("rake must be a number between 0 and 1");
  }

  return rake;
}
