import { defaultSentimentState } from "../../../agents/SentimentAgent";
import { ENGINE_STATE_KEY } from "../../../TradingEngineConstants";
import { json } from "../helpers/RuntimeParsing";
import { touchAgentHealth } from "../state/AgentStateDefaults";
import type { EngineHttpRouteContext } from "./EngineHttpRoutes";

export async function handleSentimentRoute(
  request: Request,
  context: EngineHttpRouteContext
): Promise<Response> {
  const payload = await request.json<{
    headline?: string;
    source?: string;
    url?: string | null;
    publishedAt?: string | null;
    id?: string;
  }>();
  const engineState = context.getEngineState();
  if (!context.getCachedConfig().SENTIMENT_ENABLED) {
    const observedAt = new Date().toISOString();
    const sentiment = {
      ...defaultSentimentState(),
      updatedAt: observedAt
    };
    const nextState = {
      ...engineState,
      sentiment,
      agentHealth: touchAgentHealth(
        engineState.agentHealth,
        "SENTIMENT",
        "DISABLED",
        observedAt,
        0
      ),
      heartbeatAt: observedAt,
      updatedAt: observedAt
    };
    context.setEngineState(nextState);
    await context.safeStoragePutKey(ENGINE_STATE_KEY, nextState, "SENTIMENT_DISABLED");
    return json({ ok: true, skipped: true, reason: "SENTIMENT_AGENT_DISABLED", sentiment });
  }

  const sentiment = await context.analyzeSentimentHeadline(payload.headline ?? "");
  const observedAt = sentiment.updatedAt ?? new Date().toISOString();
  const nextState = {
    ...engineState,
    sentiment,
    agentHealth: touchAgentHealth(
      engineState.agentHealth,
      "SENTIMENT",
      "GREEN",
      observedAt,
      sentiment.latencyMs ?? 0
    ),
    heartbeatAt: observedAt,
    updatedAt: observedAt
  };
  context.setEngineState(nextState);
  await context.safeStoragePutKey(ENGINE_STATE_KEY, nextState, "SENTIMENT_UPDATED");
  context.logger.info("SENTIMENT_ANALYZED", "Sentiment agent updated headline bias", {
    score: sentiment.score,
    bias: sentiment.bias,
    model: sentiment.model,
    provider: sentiment.provider ?? null,
    fallbackUsed: sentiment.fallbackUsed ?? null,
    latencyMs: sentiment.latencyMs ?? null,
    estimatedCostUsd: sentiment.estimatedCostUsd ?? 0,
    ablation: sentiment.ablation ?? null,
    source: payload.source ?? "manual",
    url: payload.url ?? null,
    publishedAt: payload.publishedAt ?? null,
    newsId: payload.id ?? null
  });
  return json({ ok: true, sentiment });
}
