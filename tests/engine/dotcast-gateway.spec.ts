import { describe, expect, it } from "vitest";
import {
  previewDotCastOdds,
  readDotCastHealth,
  simulateDotCastSettlement
} from "../../src/gateway/DotCastGateway";

describe("dotCast gateway handlers", () => {
  it("reports milestone health without requiring funds or persistence", async () => {
    const response = readDotCastHealth();
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      product: "dotCast",
      engine: "live-parimutuel"
    });
  });

  it("previews live odds and payout from integer minor-unit pools", async () => {
    const response = await previewDotCastOdds(
      jsonRequest("/api/dotcast/preview", {
        pools: { yes: 7000, no: 3000 },
        side: "yes",
        amount: 700,
        rake: 0.05
      })
    );
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      odds: { yes: 0.7, no: 0.3 },
      preview: { side: "yes", amount: 700, payout: 959 },
      rake: 0.05
    });
  });

  it("rejects malformed preview requests", async () => {
    const response = await previewDotCastOdds(
      jsonRequest("/api/dotcast/preview", {
        pools: { yes: 1, no: 0 },
        side: "maybe",
        amount: 10
      })
    );

    expect(response.status).toBe(400);
  });

  it("simulates deterministic settlement and reports conservation", async () => {
    const response = await simulateDotCastSettlement(
      jsonRequest("/api/dotcast/settlement/simulate", {
        entries: [
          { id: "yes-target", side: "yes", amount: 700 },
          { id: "yes-rest", side: "yes", amount: 6300 },
          { id: "no-pool", side: "no", amount: 3000 }
        ],
        outcome: "yes",
        rake: 0.05
      })
    );
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      conservation: {
        payoutTotal: 9850,
        rakeAmount: 150,
        totalStaked: 10000,
        conserved: true
      }
    });
  });
});

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`https://api.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}
