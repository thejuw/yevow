import type { Env, ISO8601, SentimentState } from "../types";

const MODEL = "@cf/meta/llama-3-8b-instruct";

interface WorkersAiResult {
  response?: string;
  text?: string;
}

export class SentimentAgent {
  private state: SentimentState = defaultSentimentState();

  snapshot(): SentimentState {
    return { ...this.state };
  }

  hydrate(state: SentimentState | null | undefined): void {
    if (state?.schemaVersion === "sentiment.v1") {
      this.state = {
        ...state,
        score: clamp(state.score, -1, 1),
        confidence: clamp(state.confidence, 0, 1)
      };
    }
  }

  async analyzeHeadline(
    headline: string,
    env: Env,
    observedAt: ISO8601 = new Date().toISOString()
  ): Promise<SentimentState> {
    const cleanHeadline = headline.trim().slice(0, 1_000);

    if (cleanHeadline.length === 0) {
      return this.snapshot();
    }

    const aiScore = env.AI ? await this.scoreWithWorkersAi(cleanHeadline, env) : null;
    const score = aiScore ?? lexicalScore(cleanHeadline);
    this.state = {
      schemaVersion: "sentiment.v1",
      score,
      bias: score > 0.15 ? "BULLISH" : score < -0.15 ? "BEARISH" : "NEUTRAL",
      confidence: Math.min(1, Math.abs(score) + 0.25),
      headline: cleanHeadline,
      model: env.AI ? MODEL : "lexical-fallback",
      updatedAt: observedAt
    };

    return this.snapshot();
  }

  evMultiplierFor(direction: "LONG" | "SHORT"): number {
    if (direction === "LONG" && this.state.score < 0) {
      return 1 + Math.abs(this.state.score) * 1.5;
    }

    if (direction === "SHORT" && this.state.score > 0) {
      return 1 + Math.abs(this.state.score) * 1.5;
    }

    return 1;
  }

  private async scoreWithWorkersAi(headline: string, env: Env): Promise<number | null> {
    try {
      const result = (await env.AI?.run(MODEL, {
        messages: [
          {
            role: "system",
            content:
              "Return only a decimal sentiment score from -1.0 bearish to 1.0 bullish."
          },
          { role: "user", content: headline }
        ]
      })) as WorkersAiResult | undefined;
      const text = result?.response ?? result?.text ?? "";
      const parsed = Number(text.match(/-?\d+(?:\.\d+)?/)?.[0]);
      return Number.isFinite(parsed) ? clamp(parsed, -1, 1) : null;
    } catch {
      return null;
    }
  }
}

export function defaultSentimentState(): SentimentState {
  return {
    schemaVersion: "sentiment.v1",
    score: 0,
    bias: "NEUTRAL",
    confidence: 0,
    headline: null,
    model: MODEL,
    updatedAt: null
  };
}

function lexicalScore(headline: string): number {
  const text = headline.toLowerCase();
  const bullish = ["surge", "rally", "approval", "inflow", "beat", "bull", "breakout"];
  const bearish = ["crash", "hack", "lawsuit", "outflow", "miss", "bear", "liquidation"];
  const positive = bullish.reduce((sum, word) => sum + (text.includes(word) ? 1 : 0), 0);
  const negative = bearish.reduce((sum, word) => sum + (text.includes(word) ? 1 : 0), 0);
  return clamp((positive - negative) / Math.max(1, positive + negative), -1, 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
