import type { Logger } from "../Logger";
import type { EdgeTopology, Env, JsonRecord } from "../types";
import type { AuthenticatedAdmin, CostBudgetSettings, CountRow } from "./AdminModels";
import { COST_BUDGET_SETTINGS_KEY } from "./GatewayConstants";
import { safeResponseJson } from "./AdminValidation";
import { json, readJsonBody } from "./ResponseHelpers";
import { topologyTelemetry } from "./Topology";
import { isJsonRecord, positiveNumber, round } from "./ValueCodecs";

export type EngineStateRouter = (
  request: Request,
  env: Env,
  topology: EdgeTopology
) => Promise<Response>;

export async function buildCostDashboard(
  env: Env,
  topology: EdgeTopology,
  routeToEngine: EngineStateRouter
): Promise<{
  ok: boolean;
  generatedAt: string;
  topology: JsonRecord;
  budgets: CostBudgetSettings;
  totals: JsonRecord;
  components: JsonRecord[];
  violations: JsonRecord[];
}> {
  const generatedAt = new Date().toISOString();
  const budgets = await readCostBudgetSettings(env);
  const [logs, trades, decisions, marketTicks, executionQuality, sentimentCalls, stateResponse] =
    await Promise.all([
      countTableRows(env, "logs"),
      countTableRows(env, "trades"),
      countTableRows(env, "agent_decisions"),
      countTableRows(env, "market_ticks"),
      countTableRows(env, "execution_quality"),
      countLogEvents(env, "SENTIMENT_ANALYZED"),
      routeToEngine(new Request("https://trading-engine.internal/state"), env, topology)
    ]);
  const statePayload = await safeResponseJson(stateResponse);
  const state = isJsonRecord(statePayload?.state) ? statePayload.state : {};
  const executionProfile = isJsonRecord(state.executionProfile) ? state.executionProfile : {};
  const processedTicks = Number(state.processedTicks ?? 0);
  const avgProcessingMs = Number(executionProfile.averageProcessingLatencyMs ?? 0);
  const estimatedDoComputeMs = Math.max(0, processedTicks * Math.max(0, avgProcessingMs));
  const d1WriteRows = logs + trades + decisions + marketTicks + executionQuality;
  const components = [
    costComponent(
      "WORKERS_AI",
      sentimentCalls,
      budgets.workersAiCostPerCallUsd,
      budgets.workersAiDailyBudgetUsd,
      "sentiment call"
    ),
    costComponent(
      "DURABLE_OBJECT_COMPUTE",
      estimatedDoComputeMs,
      budgets.durableObjectCostPerMsUsd,
      budgets.durableObjectDailyBudgetUsd,
      "estimated compute ms"
    ),
    costComponent(
      "D1_WRITES",
      d1WriteRows,
      budgets.d1WriteCostPerRowUsd,
      budgets.d1DailyBudgetUsd,
      "journal row"
    )
  ];
  const totalEstimatedUsd = round(
    components.reduce((sum, component) => sum + Number(component.estimatedUsd ?? 0), 0),
    8
  );
  const violations = components
    .filter((component) => component.budgetExceeded === true)
    .concat(
      budgets.dailyBudgetUsd > 0 && totalEstimatedUsd > budgets.dailyBudgetUsd
        ? [
            {
              component: "TOTAL",
              estimatedUsd: totalEstimatedUsd,
              budgetUsd: budgets.dailyBudgetUsd,
              budgetExceeded: true
            }
          ]
        : []
    );

  return {
    ok: violations.length === 0,
    generatedAt,
    topology: topologyTelemetry(topology),
    budgets,
    totals: {
      estimatedUsd: totalEstimatedUsd,
      d1WriteRows,
      sentimentCalls,
      estimatedDoComputeMs: round(estimatedDoComputeMs, 3),
      processedTicks,
      averageProcessingLatencyMs: Number.isFinite(avgProcessingMs)
        ? round(avgProcessingMs, 6)
        : null,
      model: "CONFIGURED_UNIT_COST_ESTIMATE"
    },
    components,
    violations
  };
}

export async function readCostBudgetSettings(env: Env): Promise<CostBudgetSettings> {
  const stored = await env.CONFIG_STORE.get<Partial<CostBudgetSettings>>(
    COST_BUDGET_SETTINGS_KEY,
    "json"
  ).catch(() => null);
  const now = new Date().toISOString();
  return {
    schemaVersion: "cost-budgets.v1",
    dailyBudgetUsd: nonNegativeNumberField(
      stored?.dailyBudgetUsd,
      positiveNumber(env.COST_DAILY_BUDGET_USD, 25)
    ),
    workersAiDailyBudgetUsd: nonNegativeNumberField(
      stored?.workersAiDailyBudgetUsd,
      positiveNumber(env.WORKERS_AI_DAILY_BUDGET_USD, 2)
    ),
    durableObjectDailyBudgetUsd: nonNegativeNumberField(
      stored?.durableObjectDailyBudgetUsd,
      positiveNumber(env.DO_COMPUTE_DAILY_BUDGET_USD, 10)
    ),
    d1DailyBudgetUsd: nonNegativeNumberField(
      stored?.d1DailyBudgetUsd,
      positiveNumber(env.D1_DAILY_BUDGET_USD, 5)
    ),
    workersAiCostPerCallUsd: nonNegativeNumberField(
      stored?.workersAiCostPerCallUsd,
      nonNegativeEnvNumber(env.WORKERS_AI_COST_PER_CALL_USD, 0)
    ),
    durableObjectCostPerMsUsd: nonNegativeNumberField(
      stored?.durableObjectCostPerMsUsd,
      nonNegativeEnvNumber(env.DO_COMPUTE_COST_PER_MS_USD, 0)
    ),
    d1ReadCostPerQueryUsd: nonNegativeNumberField(
      stored?.d1ReadCostPerQueryUsd,
      nonNegativeEnvNumber(env.D1_READ_COST_PER_QUERY_USD, 0)
    ),
    d1WriteCostPerRowUsd: nonNegativeNumberField(
      stored?.d1WriteCostPerRowUsd,
      nonNegativeEnvNumber(env.D1_WRITE_COST_PER_ROW_USD, 0)
    ),
    enforcement:
      stored?.enforcement === "WARN" ||
      stored?.enforcement === "BLOCK_LIVE" ||
      stored?.enforcement === "BLOCK_ALL"
        ? stored.enforcement
        : normalizeCostEnforcement(env.COST_BUDGET_ENFORCEMENT),
    updatedAt: typeof stored?.updatedAt === "string" ? stored.updatedAt : now,
    updatedBy: typeof stored?.updatedBy === "string" ? stored.updatedBy : "system-default"
  };
}

export async function readCostDashboard(
  env: Env,
  topology: EdgeTopology,
  routeToEngine: EngineStateRouter
): Promise<Response> {
  const report = await buildCostDashboard(env, topology, routeToEngine);
  return json({ ok: report.ok, cost: report }, report.ok ? 200 : 409);
}

export async function updateCostBudgets(
  request: Request,
  env: Env,
  logger: Logger,
  topology: EdgeTopology,
  admin: AuthenticatedAdmin
): Promise<Response> {
  const body = (await readJsonBody<Partial<CostBudgetSettings>>(request)) ?? {};
  const current = await readCostBudgetSettings(env);
  const next: CostBudgetSettings = {
    ...current,
    dailyBudgetUsd: nonNegativeNumberField(body.dailyBudgetUsd, current.dailyBudgetUsd),
    workersAiDailyBudgetUsd: nonNegativeNumberField(
      body.workersAiDailyBudgetUsd,
      current.workersAiDailyBudgetUsd
    ),
    durableObjectDailyBudgetUsd: nonNegativeNumberField(
      body.durableObjectDailyBudgetUsd,
      current.durableObjectDailyBudgetUsd
    ),
    d1DailyBudgetUsd: nonNegativeNumberField(body.d1DailyBudgetUsd, current.d1DailyBudgetUsd),
    workersAiCostPerCallUsd: nonNegativeNumberField(
      body.workersAiCostPerCallUsd,
      current.workersAiCostPerCallUsd
    ),
    durableObjectCostPerMsUsd: nonNegativeNumberField(
      body.durableObjectCostPerMsUsd,
      current.durableObjectCostPerMsUsd
    ),
    d1ReadCostPerQueryUsd: nonNegativeNumberField(
      body.d1ReadCostPerQueryUsd,
      current.d1ReadCostPerQueryUsd
    ),
    d1WriteCostPerRowUsd: nonNegativeNumberField(
      body.d1WriteCostPerRowUsd,
      current.d1WriteCostPerRowUsd
    ),
    enforcement:
      body.enforcement === "WARN" ||
      body.enforcement === "BLOCK_LIVE" ||
      body.enforcement === "BLOCK_ALL"
        ? body.enforcement
        : current.enforcement,
    updatedAt: new Date().toISOString(),
    updatedBy: admin.subject
  };

  await env.CONFIG_STORE.put(COST_BUDGET_SETTINGS_KEY, JSON.stringify(next));
  logger.warn("COST_BUDGETS_UPDATED", "Admin updated telemetry cost budgets", {
    actor: admin.subject,
    budgets: toJsonRecord(next),
    colo: topology.colo,
    placement: topology.placement
  });

  return json({ ok: true, budgets: next });
}

async function countLogEvents(env: Env, eventType: string): Promise<number> {
  const row = await env.TRADING_DB.prepare(
    `SELECT COUNT(*) AS count FROM logs
     WHERE event_type = ?
       AND created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')`
  )
    .bind(eventType)
    .first<CountRow>();
  return Number(row?.count ?? 0);
}

async function countTableRows(env: Env, tableName: string): Promise<number> {
  const row = await env.TRADING_DB.prepare(
    `SELECT COUNT(*) AS count FROM ${tableName}
     WHERE created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')`
  ).first<CountRow>();
  return Number(row?.count ?? 0);
}

function costComponent(
  component: string,
  quantity: number,
  unitCostUsd: number,
  budgetUsd: number,
  unit: string
): JsonRecord {
  const estimatedUsd = round(quantity * unitCostUsd, 8);
  return {
    component,
    quantity: round(quantity, 6),
    unit,
    unitCostUsd,
    estimatedUsd,
    budgetUsd,
    budgetExceeded: budgetUsd > 0 && estimatedUsd > budgetUsd
  };
}

function nonNegativeEnvNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function nonNegativeNumberField(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeCostEnforcement(value: string | undefined): CostBudgetSettings["enforcement"] {
  return value === "WARN" || value === "BLOCK_ALL" || value === "BLOCK_LIVE" ? value : "BLOCK_LIVE";
}

function toJsonRecord(value: unknown): JsonRecord {
  return JSON.parse(JSON.stringify(value ?? {})) as JsonRecord;
}
