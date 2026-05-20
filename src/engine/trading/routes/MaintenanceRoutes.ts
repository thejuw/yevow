import { logPruneReportToJson } from "../../LogRetention";
import {
  ENGINE_STATE_KEY,
  PERFORMANCE_HISTORY_KEY,
  PROCESSING_LATENCY_SAMPLES_KEY
} from "../../../TradingEngineConstants";
import { json, readJsonOrNull } from "../helpers/RuntimeParsing";
import {
  aggregateQuoteState,
  resumeExpiredAssetQuoteStates,
  suspendAssetQuoteStates
} from "../state/AssetStateRuntime";
import type { EngineHttpRouteContext } from "./EngineHttpRoutes";

export async function handleMaintenanceRoute(
  request: Request,
  url: URL,
  context: EngineHttpRouteContext
): Promise<Response | null> {
  if (request.method === "POST" && url.pathname === "/maintenance/reset-latency") {
    const observedAt = new Date().toISOString();
    const engineState = context.getEngineState();
    const shouldClearQuoteSuspension =
      engineState.quoteState.status === "SUSPENDED" &&
      (engineState.quoteState.reason === "HARD_STALE_DROP" ||
        engineState.quoteState.reason === "NATIVE_HL_LATENCY" ||
        engineState.quoteState.reason === "GRPC_FATAL_DROP" ||
        engineState.quoteState.reason === "STALE_DATA_KILL_SWITCH");
    context.resetLatencyBaseline(observedAt, "ADMIN_MAINTENANCE");
    const recoveredAssetQuoteStates = shouldClearQuoteSuspension
      ? resumeExpiredAssetQuoteStates(
          suspendAssetQuoteStates(engineState.assetQuoteStates, "ADMIN_RESET_LATENCY", observedAt, {
            suspendedUntil: observedAt
          }),
          observedAt
        )
      : engineState.assetQuoteStates;
    const recoveredQuoteState = shouldClearQuoteSuspension
      ? aggregateQuoteState(recoveredAssetQuoteStates, engineState.quoteState, observedAt)
      : engineState.quoteState;
    const nextState = {
      ...engineState,
      staleTickCount: 0,
      quoteState: recoveredQuoteState,
      assetQuoteStates: recoveredAssetQuoteStates,
      updatedAt: observedAt
    };
    context.setEngineState(nextState);
    if (shouldClearQuoteSuspension) {
      context.publish("RESUME_QUOTES", {
        reason: "ADMIN_RESET_LATENCY",
        observedAt
      });
    }
    await context.safeStoragePutEntries(
      {
        [ENGINE_STATE_KEY]: nextState,
        [PERFORMANCE_HISTORY_KEY]: context.getLatencyHistory(),
        [PROCESSING_LATENCY_SAMPLES_KEY]: context.getProcessingLatencySamples()
      },
      "ADMIN_RESET_LATENCY"
    );
    return json({ ok: true, state: nextState });
  }

  if (request.method === "POST" && url.pathname === "/maintenance/recover") {
    const payload =
      (await readJsonOrNull<{
        reason?: string;
        resetInstruments?: string[] | string;
        instrumentCode?: string;
        source_exchange?: string;
        clearCitadel?: boolean;
        clearQuoteState?: boolean;
        clearLatency?: boolean;
        resetPaperPortfolio?: boolean;
        clearShadowQueue?: boolean;
      }>(request)) ?? {};
    const recovery = await context.recoverEngineState(payload);

    return json(recovery);
  }

  if (request.method === "POST" && url.pathname === "/maintenance/prune-logs") {
    const report = await context.pruneOperationalLogs();
    context.logger.warn("ADMIN_LOG_PRUNE_APPLIED", "Admin-triggered stale log cleanup completed", {
      report: logPruneReportToJson(report)
    });

    return json({ ok: true, report });
  }

  return null;
}
