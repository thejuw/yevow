import type { EngineState, ReplayResult } from "../../../types";
import {
  clampInteger,
  json,
  nonNegativeFiniteNumber,
  readJsonOrNull,
  readPositiveNumber,
  sanitizeIsoDate
} from "./RouteUtils";

export const DEFAULT_REPLAY_LIMIT = 250;

export type ReplayScenario = "BASELINE" | "FLASH_CRASH" | "DELEVERAGING_2022" | "LATENCY_SHOCK";

export interface ReplayStatus {
  replayId: string | null;
  status: "IDLE" | "RUNNING" | "COMPLETED" | "FAILED";
  ticksTotal: number;
  ticksProcessed: number;
  progressPct: number;
  speedMultiplier: number;
  shadowBankroll: number;
  dateFrom: string | null;
  dateTo: string | null;
  scenario?: ReplayScenario;
  error: string | null;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
}

export interface ReplayOptions {
  scenario: ReplayScenario;
  latencyMs: number;
  slippageBps: number;
  feeBps: number;
  exitAfterTicks: number;
  walkForward: boolean;
  sentimentAblation: boolean;
  strategyVersionId: string | null;
  actor: string;
}

export interface ReplayAdminPayload {
  limit?: number;
  shadowBankroll?: number;
  speedMultiplier?: number;
  dateFrom?: string;
  dateTo?: string;
  from?: string;
  to?: string;
  scenario?: string;
  latencyMs?: number;
  slippageBps?: number;
  feeBps?: number;
  exitAfterTicks?: number;
  walkForward?: boolean;
  sentimentAblation?: boolean;
  strategyVersionId?: string | null;
  actor?: string;
}

export interface ReplayInvocation {
  limit: number;
  shadowBankroll: number;
  speedMultiplier: number;
  dateFrom: string | null;
  dateTo: string | null;
  options: ReplayOptions;
}

export interface ReplayAdminRouteContext {
  exchangeFeeBps: number;
  getEngineState(): EngineState;
  runHistoricalReplay(
    limit: number,
    shadowBankroll: number,
    speedMultiplier: number,
    dateFrom: string | null,
    dateTo: string | null,
    replayOptions: ReplayOptions
  ): Promise<ReplayResult>;
  currentReplayStatus(): Promise<ReplayStatus>;
}

export async function handleReplayAdminRoute(
  request: Request,
  url: URL,
  context: ReplayAdminRouteContext
): Promise<Response | null> {
  if (request.method === "POST" && url.pathname === "/admin/replay") {
    const payload = await readJsonOrNull<ReplayAdminPayload>(request);
    const invocation = buildReplayInvocation(payload, context.exchangeFeeBps);
    const result = await context.runHistoricalReplay(
      invocation.limit,
      invocation.shadowBankroll,
      invocation.speedMultiplier,
      invocation.dateFrom,
      invocation.dateTo,
      invocation.options
    );

    return json({ ok: true, replay: result, state: context.getEngineState() });
  }

  if (request.method === "GET" && url.pathname === "/admin/replay/status") {
    return json({
      ok: true,
      replay: await context.currentReplayStatus()
    });
  }

  return null;
}

export function buildReplayInvocation(
  payload: ReplayAdminPayload | null,
  exchangeFeeBps: number
): ReplayInvocation {
  return {
    limit: clampInteger(
      payload?.limit === undefined ? null : String(payload.limit),
      DEFAULT_REPLAY_LIMIT,
      1,
      5_000
    ),
    shadowBankroll: typeof payload?.shadowBankroll === "number" ? payload.shadowBankroll : 0,
    speedMultiplier: readPositiveNumber(
      payload?.speedMultiplier === undefined ? undefined : String(payload.speedMultiplier),
      1
    ),
    dateFrom: sanitizeIsoDate(payload?.dateFrom ?? payload?.from),
    dateTo: sanitizeIsoDate(payload?.dateTo ?? payload?.to),
    options: {
      scenario: sanitizeReplayScenario(payload?.scenario),
      latencyMs: nonNegativeFiniteNumber(payload?.latencyMs, 10),
      slippageBps: nonNegativeFiniteNumber(payload?.slippageBps, 1),
      feeBps: nonNegativeFiniteNumber(payload?.feeBps, exchangeFeeBps),
      exitAfterTicks: clampInteger(
        payload?.exitAfterTicks === undefined ? null : String(payload.exitAfterTicks),
        10,
        1,
        500
      ),
      walkForward: payload?.walkForward === true,
      sentimentAblation: payload?.sentimentAblation !== false,
      strategyVersionId:
        typeof payload?.strategyVersionId === "string" && payload.strategyVersionId.trim()
          ? payload.strategyVersionId.trim()
          : null,
      actor:
        typeof payload?.actor === "string" && payload.actor.trim()
          ? payload.actor.trim().slice(0, 100)
          : "admin"
    }
  };
}

export function sanitizeReplayScenario(value: string | undefined): ReplayScenario {
  if (value === "FLASH_CRASH" || value === "DELEVERAGING_2022" || value === "LATENCY_SHOCK") {
    return value;
  }

  return "BASELINE";
}
