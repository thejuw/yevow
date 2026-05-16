import { expect, test, type Page } from "@playwright/test";

const API_BASE = "https://api.yevow.co";

test.describe("Grand Command admin dashboard", () => {
  test("logs in, toggles governance, edits AM-VPIN controls, and renders high-impact confirmation", async ({ page }) => {
    const api = await installApiMock(page);
    await loginToDashboard(page);

    await expect(page.getByText(/SYSTEM IS OPERATING IN SHADOW MODE/)).toBeVisible();
    await expect(page.getByText("Paper MTM").first()).toBeVisible();
    await expect(page.getByRole("button", { name: /\[ AUTONOMOUS MODE \]/ })).toBeVisible();

    await page.getByRole("button", { name: /\[ AUTONOMOUS MODE \]/ }).click();
    await expect(page.getByRole("button", { name: /\[ MANUAL INTERVENTION \]/ })).toBeVisible();

    await page.getByTestId("param-AM_VPIN_ROLLING_WINDOW").fill("65");
    await page.getByTestId("param-AM_VPIN_DIRECTIONAL_DECAY").fill("0.42");
    await page.getByRole("button", { name: "APPLY CHANGES" }).click();

    await expect(page.getByText("Warning: Overriding System 2 Logic")).toBeVisible();
    await expect(page.locator(".confirm-modal")).toContainText("AM_VPIN_ROLLING_WINDOW");

    await page.locator(".confirm-modal input").fill("CONFIRM");
    await page.getByRole("button", { name: "Confirm" }).click();

    await expect(page.getByText("Matrix applied.")).toBeVisible();
    expect(api.configUpdates.at(-1)).toMatchObject({
      AM_VPIN_ROLLING_WINDOW: 65,
      AM_VPIN_DIRECTIONAL_DECAY: 0.42
    });
  });

  test("rejects negative and out-of-bounds matrix variables before backend submission", async ({ page }) => {
    const api = await installApiMock(page);
    await loginToDashboard(page);

    await page.getByRole("button", { name: /\[ AUTONOMOUS MODE \]/ }).click();
    const before = api.configPostCount;

    await page.getByTestId("param-AM_VPIN_DIRECTIONAL_DECAY").fill("-0.01");
    await page.getByRole("button", { name: "APPLY CHANGES" }).click();

    await expect(page.getByText(/Directional Decay.*greater than or equal to 0/i)).toBeVisible();
    expect(api.configPostCount).toBe(before);

    await page.getByTestId("param-AM_VPIN_DIRECTIONAL_DECAY").fill("0.3");
    await page.getByTestId("param-AM_VPIN_ROLLING_WINDOW").fill("9999");
    await page.getByRole("button", { name: "APPLY CHANGES" }).click();

    await expect(page.getByText(/AM-VPIN Window.*less than or equal to 500/i)).toBeVisible();
    expect(api.configPostCount).toBe(before);
  });
});

async function loginToDashboard(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("API").fill(API_BASE);
  await page.getByLabel("Admin Password").fill("phase-59-test-password");
  await page.getByRole("button", { name: "Unlock Admin" }).click();
  await expect(page.getByText("Moltworker Grand Command")).toBeVisible();
}

async function installApiMock(page: Page): Promise<{
  configPostCount: number;
  configUpdates: Array<Record<string, unknown>>;
}> {
  const now = new Date().toISOString();
  const api = {
    configPostCount: 0,
    configUpdates: [] as Array<Record<string, unknown>>
  };
  let config = baseConfig(now);

  await page.route(`${API_BASE}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path === "/login") {
      await route.fulfill({ json: { ok: true, token: "test-token", tokenType: "Bearer", expiresIn: 3600, scopes: ["READ", "WRITE"] } });
      return;
    }

    if (path === "/admin/config") {
      if (request.method() === "GET") {
        await route.fulfill({ json: { ok: true, config } });
        return;
      }
      api.configPostCount += 1;
      const body = request.postDataJSON() as { config?: Record<string, unknown> };
      const update = body.config ?? {};
      api.configUpdates.push(update);
      config = { ...config, ...update, updatedAt: new Date().toISOString(), version: `test-${api.configPostCount}` };
      await route.fulfill({ json: { ok: true, config } });
      return;
    }

    if (path === "/admin/state") {
      await route.fulfill({ json: { state: baseState(config), orderBook: {} } });
      return;
    }

    if (path === "/admin/trace") {
      await route.fulfill({ json: { ok: true, terminalFeed: [], data: [], liveTelemetry: [] } });
      return;
    }

    if (path === "/admin/attribution") {
      await route.fulfill({ json: { ok: true, byDriver: [], timeline: [] } });
      return;
    }

    if (path === "/admin/history") {
      await route.fulfill({
        json: {
          ok: true,
          data: [
            {
              tradeId: "ghost-1",
              orderId: "ghost-order-1",
              signalId: "sig-1",
              venue: "hyperliquid",
              asset: "BTC",
              side: "BUY",
              orderType: "LIMIT",
              price: 100,
              size: 1,
              notional: 100,
              evAtExecution: 0.12,
              slippageBps: 0,
              resultingPnl: 0,
              primaryDriver: "CROUPIER",
              fees: 0,
              status: "GHOST_FILL",
              exchangeTradeId: "ghost-1",
              rawExecution: {},
              agentName: "CROUPIER",
              traceId: "trace-1",
              executedAt: now,
              createdAt: now
            }
          ],
          paperPnl: {
            windowHours: 24,
            mode: "SHADOW_MARK_TO_MARKET",
            assets: [
              {
                asset: "BTC",
                tradeCount: 1,
                buyCount: 1,
                sellCount: 0,
                buySize: 1,
                sellSize: 0,
                buyNotional: 100,
                sellNotional: 0,
                netQuantity: 1,
                cashPnl: -100,
                grossNotional: 100,
                realizedPnl: 0,
                totalEv: 0.12,
                totalFees: 0,
                firstSeen: now,
                lastSeen: now
              }
            ],
            totals: {
              tradeCount: 1,
              buyCount: 1,
              sellCount: 0,
              grossNotional: 100,
              cashPnl: -100,
              realizedPnl: 0,
              totalEv: 0.12,
              totalFees: 0
            },
            generatedAt: now
          },
          pagination: { page: 1, limit: 50, total: 0, pageCount: 0, hasNextPage: false, hasPreviousPage: false },
          filters: { statusMode: "ALL" }
        }
      });
      return;
    }

    if (path === "/admin/alerts") {
      await route.fulfill({ json: { ok: true, alerting: { configured: false, debounceMs: 60000, channels: [] } } });
      return;
    }

    if (path === "/admin/settings") {
      await route.fulfill({
        json: {
          ok: true,
          config,
          notifications: {},
          alerting: { configured: false, debounceMs: 60000, channels: [] },
          vault: { entries: {}, rotationPolicy: "test" },
          backend: { execution: { shadowMode: "true" } }
        }
      });
      return;
    }

    await route.fulfill({ status: 404, json: { ok: false, error: "UNMOCKED_ROUTE", path } });
  });

  return api;
}

function baseConfig(now: string) {
  return {
    TRADING_ENABLED: true,
    MAX_POSITION_SIZE: 1,
    MAX_POSITION_PCT: 0.05,
    MAX_INVENTORY_UNITS: 5,
    MAX_INVENTORY_DELTA: 1,
    MAX_DRAWDOWN_PCT: 0.2,
    LATENCY_THRESHOLD_MS: 2000,
    GOLDEN_COLOS: "BRU",
    MIN_EV_THRESHOLD: 0,
    EXCHANGE_FEE_BPS: 5,
    KELLY_FRACTION: 0.5,
    RISK_AVERSION_FACTOR: 0.01,
    FUNDING_BIAS_THRESHOLD: 0.00001,
    FUNDING_INVENTORY_BIAS: 0.25,
    QUOTE_HIBERNATE_MS: 3000,
    AM_VPIN_BUCKET_VOLUME: 10,
    AM_VPIN_ROLLING_WINDOW: 50,
    AM_VPIN_DIRECTIONAL_DECAY: 0.3,
    AM_VPIN_NORMAL_THRESHOLD: 0.65,
    AM_VPIN_TOXIC_THRESHOLD: 0.75,
    AM_VPIN_CRITICAL_THRESHOLD: 0.85,
    AM_VPIN_OBI_DEPTH: 5,
    AM_VPIN_CRITICAL_OBI: 0.8,
    AM_VPIN_QUOTE_HALT_MS: 60000,
    VAR_CONFIDENCE_Z: 2.326,
    ORACLE_GOVERNANCE_MODE: "AUTONOMOUS",
    ORACLE_MANUAL_SKEPTICISM: 1.4,
    ORACLE_MAX_SKEPTICISM: 4,
    updatedAt: now,
    updatedBy: "playwright",
    version: "test"
  };
}

function baseState(config: ReturnType<typeof baseConfig>) {
  const now = new Date().toISOString();
  return {
    engineId: "test-engine",
    mode: "PAPER",
    bankroll: { currency: "USD", cash: 1000, equity: 1000, realizedPnl: 0, updatedAt: now },
    openPositions: {},
    riskMetrics: { highWaterMark: 1000, rollingDrawdownPct: 0, var99OneHour: 0, isTradingEnabled: true, updatedAt: now },
    processedTicks: 100,
    acceptedSignals: 10,
    averageLatency: 450,
    staleTickCount: 0,
    toxicityScore: 0.25,
    current_inventory_delta: 0,
    liquidationHeatmap: {
      schemaVersion: "liquidation-heatmap.v1",
      source_exchange: "hyperliquid",
      instrumentCode: "btc-usd",
      clusters: [],
      nearestCascade: null,
      recentEvents: [],
      totalEstimatedNotionalUsd: 0,
      sampledWalletCount: 0,
      lastSampleAt: null,
      updatedAt: now
    },
    cachedConfig: config,
    macroBias: { direction: "NEUTRAL", intensity: 0, confidence: 0, reason: "test" },
    temporaryOverride: null,
    assetMatrix: {
      "btc-usd": { instrumentCode: "btc-usd", coin: "BTC", active: true, selectedByMoltworker: true, capitalAllocationPct: 0.25, midPrice: 101 },
      "eth-usd": { instrumentCode: "eth-usd", coin: "ETH", active: true, selectedByMoltworker: true, capitalAllocationPct: 0.25, midPrice: 2500 }
    },
    profilerStates: {},
    microstructure: { bestBid: 100, bestAsk: 101, midPrice: 100.5, spreadBps: 10, weightedImbalance: 0.1, depthLevels: 20, timeToBookMs: 1, updatedAt: now },
    oracle: { skepticismMultiplier: 1.4 },
    inventory: { netDelta: 0, current_inventory_delta: 0, baseAsset: "BTC", normalization: {}, maxInventoryUnits: 5, maxInventoryDelta: 1, inventoryPenalty: 0, stopBid: false, stopAsk: false },
    quoteState: { status: "ACTIVE", reason: null, suspendedUntil: null },
    executionProfile: { status: "STABLE", jitterMs: 1, jitterThresholdMs: 10, averageProcessingLatencyMs: 0, orderBookUpdateMs: 0, agentLogicMs: 0, wakeUpTimeMs: 0 },
    citadel: { status: "NOMINAL", reason: null, shadowMode: true, lastEvacuationAt: null, updatedAt: now },
    location: { colo: "BRU", isGoldenRegion: true, latencyRiskMultiplier: 1, positionSizeMultiplier: 1 },
    lastTradeIntent: null,
    orderMap: {},
    heartbeatAt: now,
    updatedAt: now
  };
}
