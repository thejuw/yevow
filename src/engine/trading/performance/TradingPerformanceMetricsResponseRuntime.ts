import type { EngineState } from "../../../types";
import { buildPerformanceMetricsText } from "./LatencyRuntime";

export function buildTradingPerformanceMetricsResponse(
  engineState: Pick<
    EngineState,
    "engineId" | "executionProfile" | "processedTicks" | "toxicityScore"
  >
): Response {
  const body = buildPerformanceMetricsText({
    engineId: engineState.engineId,
    profile: engineState.executionProfile,
    processedTicks: engineState.processedTicks,
    toxicityScore: engineState.toxicityScore
  });

  return new Response(body, {
    headers: {
      "content-type": "text/plain; version=0.0.4;charset=UTF-8",
      "cache-control": "no-store"
    }
  });
}
