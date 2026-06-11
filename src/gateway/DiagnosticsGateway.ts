import type { Logger } from "../Logger";
import type { EdgeTopology, Env, JsonRecord } from "../types";
import { safeResponseJson } from "./AdminValidation";
import { evaluateHyperliquidSecrets } from "./HyperliquidSecretDiagnostics";
import { evaluateMoltworkerHeartbeat } from "./MoltworkerGateway";
import { json } from "./ResponseHelpers";
import { topologyTelemetry } from "./Topology";
import { isJsonRecord, positiveNumber } from "./ValueCodecs";

export type DiagnosticsEngineRouter = (
  request: Request,
  env: Env,
  topology: EdgeTopology
) => Promise<Response>;

export async function runDiagnostics(
  env: Env,
  logger: Logger,
  topology: EdgeTopology,
  routeToEngine: DiagnosticsEngineRouter
): Promise<Response> {
  const observedAt = new Date().toISOString();
  const engineResponse = await routeToEngine(
    new Request("https://trading-engine.internal/diagnostics"),
    env,
    topology
  );
  const engineDiagnostics = await safeResponseJson(engineResponse);
  const d1StartedAt = performance.now();
  let d1Ok = false;
  let d1Error: string | null = null;

  try {
    await env.TRADING_DB.prepare("SELECT 1 AS ok").first();
    d1Ok = true;
  } catch (error) {
    d1Error = error instanceof Error ? error.message : "D1_QUERY_FAILED";
  }

  const d1LatencyMs = Math.round((performance.now() - d1StartedAt) * 1000) / 1000;
  const d1DiagnosticMaxLatencyMs = positiveNumber(env.D1_DIAGNOSTIC_MAX_LATENCY_MS, 250);
  const secretDiagnostic = await evaluateHyperliquidSecrets(env);
  const moltworker = await evaluateMoltworkerHeartbeat(env);
  const l1Sync = isJsonRecord(engineDiagnostics?.l1Sync) ? engineDiagnostics.l1Sync : null;
  const v8Memory = isJsonRecord(engineDiagnostics?.v8Memory) ? engineDiagnostics.v8Memory : null;
  const checks = [
    diagnosticCheck(
      "l1_sync",
      "L1 Sync Check",
      Boolean(l1Sync?.ok),
      l1Sync?.ok
        ? "Hyperliquid book sequence state is synchronized."
        : `Desync detected across ${Number(l1Sync?.desyncCount ?? 0)} market(s).`,
      l1Sync
    ),
    diagnosticCheck(
      "secret_valuation",
      "Secret Valuations",
      secretDiagnostic.ok,
      secretDiagnostic.detail,
      secretDiagnostic.metadata
    ),
    diagnosticCheck(
      "v8_memory_layout",
      "V8 Memory Layout",
      Boolean(v8Memory?.ok),
      v8Memory?.ok
        ? "Profiler Float32Array buffers are flat and below heap pressure limits."
        : "Profiler memory layout or heap pressure requires review.",
      v8Memory
    ),
    diagnosticCheck(
      "d1_log_latency",
      "D1 Log Latency",
      d1Ok && d1LatencyMs < d1DiagnosticMaxLatencyMs,
      d1Ok
        ? `D1 round trip ${d1LatencyMs}ms.`
        : `D1 diagnostic query failed: ${d1Error ?? "UNKNOWN_ERROR"}.`,
      { latencyMs: d1LatencyMs, thresholdMs: d1DiagnosticMaxLatencyMs, error: d1Error }
    ),
    diagnosticCheck(
      "moltworker_heartbeat",
      "Moltworker Heartbeat",
      moltworker.ok,
      moltworker.detail,
      moltworker.metadata,
      moltworker.status
    )
  ];
  const ok = checks.every((check) => check.status === "OPTIMAL");

  logger.info("ADMIN_DIAGNOSTICS_RUN", "Admin integrity diagnostics executed", {
    ok,
    colo: topology.colo,
    placement: topology.placement,
    checkSummary: Object.fromEntries(checks.map((check) => [check.id, check.status]))
  });

  return json({
    ok,
    observedAt,
    topology,
    checks,
    engine: engineDiagnostics
  });
}

function diagnosticCheck(
  id: string,
  label: string,
  ok: boolean,
  detail: string,
  metadata: unknown,
  overrideStatus?: "OPTIMAL" | "WARN" | "ANOMALY"
): JsonRecord {
  return {
    id,
    label,
    status: overrideStatus ?? (ok ? "OPTIMAL" : "ANOMALY"),
    detail,
    metadata: toJsonRecord(metadata)
  };
}

function toJsonRecord(value: unknown): JsonRecord {
  if (isJsonRecord(value)) {
    return value;
  }

  return JSON.parse(JSON.stringify(value ?? {})) as JsonRecord;
}
