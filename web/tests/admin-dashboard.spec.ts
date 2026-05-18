import { expect, test, type Page } from "@playwright/test";

const API_BASE = "https://api.yevow.co";

test.describe("Grand Command admin dashboard", () => {
  test("logs in, shows shadow posture, and toggles governance", async ({ page }) => {
    const api = await installApiMock(page);
    await loginToDashboard(page);

    await expect(page.getByText(/SYSTEM IS OPERATING IN SHADOW MODE/)).toBeVisible();
    await expect(page.getByText("Paper MTM").first()).toBeVisible();
    await expect(page.getByRole("button", { name: /\[ AUTONOMOUS MODE \]/ })).toBeVisible();

    await page.getByRole("button", { name: /\[ AUTONOMOUS MODE \]/ }).click();
    await expect(page.getByRole("button", { name: /\[ MANUAL INTERVENTION \]/ })).toBeVisible();
    expect(api.configUpdates.at(-1)).toMatchObject({
      ORACLE_GOVERNANCE_MODE: "MANUAL"
    });
  });

  test("edits Settings AM-VPIN controls and renders high-impact confirmation", async ({ page }) => {
    const api = await installApiMock(page);
    await loginToSettings(page);

    await page.getByTestId("param-AM_VPIN_ROLLING_WINDOW").fill("65");
    await page.getByTestId("param-AM_VPIN_DIRECTIONAL_DECAY").fill("0.42");
    await page.getByRole("button", { name: "Save Matrix" }).click();

    await expect(page.getByText("Confirm Matrix Change")).toBeVisible();
    await expect(page.locator(".confirm-modal")).toContainText("AM_VPIN_ROLLING_WINDOW");

    await page.locator(".confirm-modal input").fill("CONFIRM");
    await page.getByRole("button", { name: "Confirm" }).click();

    await expect(page.getByText("Engine parameters saved and refreshed.")).toBeVisible();
    expect(api.configUpdates.at(-1)).toMatchObject({
      AM_VPIN_ROLLING_WINDOW: 65,
      AM_VPIN_DIRECTIONAL_DECAY: 0.42
    });
  });

  test("shows cascade recovery panels and can request an operator close", async ({ page }) => {
    const api = await installApiMock(page);
    await loginToDashboard(page);

    await expect(page.getByText("Strategy Mode")).toBeVisible();
    await expect(page.getByLabel("Strategy selector")).toBeVisible();
    await expect(page.getByLabel("Cascade asset toggles")).toContainText("ETH");
    await expect(page.getByLabel("Cascade asset toggles")).toContainText("SOL");
    await expect(page.getByText("Cascade Recovery Ops")).toBeVisible();
    await expect(page.getByText("Active Cascades").first()).toBeVisible();
    await expect(page.getByText("Open Positions").first()).toBeVisible();
    await expect(page.getByText("Recent Signals").first()).toBeVisible();

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Close" }).click();
    await expect(page.getByText("Cascade close intent dispatched.")).toBeVisible();
    expect(api.cascadeCloseCount).toBe(1);
  });

  test("toggles cascade assets and runs cascade replay validation", async ({ page }) => {
    const api = await installApiMock(page);
    await loginToDashboard(page);

    await page
      .getByLabel("Cascade asset toggles")
      .getByRole("button", { name: /○ HYPE/ })
      .click();
    expect(api.configUpdates.at(-1)).toMatchObject({
      CASCADE_INSTRUMENTS: "BTC,ETH,SOL,HYPE"
    });

    await page.getByRole("button", { name: "Cascade Validate" }).click();
    await expect(page.locator(".cascade-validation-grid")).toContainText("PASS");
    expect(api.cascadeBacktestCount).toBe(1);
  });

  test("wires dashboard diagnostics and replay actions", async ({ page }) => {
    const api = await installApiMock(page);
    await loginToDashboard(page);

    await page.getByRole("button", { name: "Run Integrity Check" }).click();
    await expect(page.getByText("System Integrity Protocol")).toBeVisible();
    expect(api.diagnosticsCount).toBe(1);

    await page.locator(".diagnostics-modal").getByRole("button", { name: "Close" }).click();
    await page.getByRole("button", { name: "Run Replay" }).click();
    await expect(page.getByText("Shadow replay completed and journaled.")).toBeVisible();
    expect(api.replayCount).toBe(1);
  });

  test("shows cascade-specific parameter sections when cascade mode is armed", async ({ page }) => {
    await installApiMock(page);
    await loginToSettings(page);

    await expect(page.getByText("Cascade Detection Parameters")).toBeVisible();
    await expect(page.getByText("Cascade Entry & Exit Parameters")).toBeVisible();
    await expect(page.getByText("Cascade Risk Limits")).toBeVisible();
    await expect(page.getByTestId("param-CASCADE_NOTIONAL_THRESHOLD_USD").first()).toBeVisible();
    await expect(page.getByTestId("param-PARTIAL_1_R").first()).toBeVisible();
    await expect(page.getByTestId("param-DAILY_LOSS_LIMIT_PCT").first()).toBeVisible();
  });

  test("rejects negative and out-of-bounds matrix variables before backend submission", async ({
    page
  }) => {
    const api = await installApiMock(page);
    await loginToSettings(page);

    const before = api.configPostCount;

    await page.getByTestId("param-AM_VPIN_DIRECTIONAL_DECAY").fill("-0.01");
    await page.getByRole("button", { name: "Save Matrix" }).click();

    await expect(page.getByText(/Directional Decay.*greater than or equal to 0/i)).toBeVisible();
    expect(api.configPostCount).toBe(before);

    await page.getByTestId("param-AM_VPIN_DIRECTIONAL_DECAY").fill("0.3");
    await page.getByTestId("param-AM_VPIN_ROLLING_WINDOW").fill("9999");
    await page.getByRole("button", { name: "Save Matrix" }).click();

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

async function loginToSettings(page: Page): Promise<void> {
  await page.goto("/settings");
  await page.getByLabel("API").fill(API_BASE);
  await page.getByLabel("Admin Password").fill("phase-59-test-password");
  await page.getByRole("button", { name: "Unlock Settings" }).click();
  await expect(page.getByText("Backend Settings Console")).toBeVisible();
}

async function installApiMock(page: Page): Promise<{
  configPostCount: number;
  configUpdates: Array<Record<string, unknown>>;
  cascadeCloseCount: number;
  cascadeBacktestCount: number;
  diagnosticsCount: number;
  replayCount: number;
}> {
  const now = new Date().toISOString();
  const api = {
    configPostCount: 0,
    configUpdates: [] as Array<Record<string, unknown>>,
    cascadeCloseCount: 0,
    cascadeBacktestCount: 0,
    diagnosticsCount: 0,
    replayCount: 0
  };
  let config = baseConfig(now);

  await page.route(`${API_BASE}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path === "/login") {
      await route.fulfill({
        json: {
          ok: true,
          token: "test-token",
          tokenType: "Bearer",
          expiresIn: 3600,
          scopes: ["READ", "WRITE"]
        }
      });
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
      config = {
        ...config,
        ...update,
        updatedAt: new Date().toISOString(),
        version: `test-${api.configPostCount}`
      };
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
          pagination: {
            page: 1,
            limit: 50,
            total: 0,
            pageCount: 0,
            hasNextPage: false,
            hasPreviousPage: false
          },
          filters: { statusMode: "ALL" }
        }
      });
      return;
    }

    if (path === "/admin/cascade/active") {
      await route.fulfill({
        json: {
          ok: true,
          cascades: [
            {
              cascadeId: "cascade-btc-1",
              instrumentCode: "btc-usd",
              direction: "LONG_LIQUIDATION",
              phase: "ABSORPTION_CONFIRMED",
              liquidationNotional: 12500000,
              liquidationCount: 12,
              zScore: 4.2,
              directionalPct: 0.88,
              priceMoveAtr: 1.7,
              detectedAt: now,
              absorption: {},
              position: null
            }
          ]
        }
      });
      return;
    }

    if (path === "/admin/cascade/positions") {
      await route.fulfill({
        json: {
          ok: true,
          positions: [
            {
              positionId: "cascade-position-1",
              signalId: "cascade-signal-1",
              cascadeId: "cascade-btc-1",
              instrumentCode: "btc-usd",
              direction: "LONG",
              status: "ENTERED",
              entryPrice: 100,
              currentStopPrice: 95,
              initialStopPrice: 95,
              totalSize: 1,
              remainingSize: 1,
              initialRiskPct: 0.005,
              rDistance: 5,
              targets: {},
              timeStopAt: new Date(Date.now() + 3600000).toISOString(),
              firstTargetTaken: false,
              secondTargetTaken: false,
              enteredAt: now,
              updatedAt: now,
              markPrice: 103,
              unrealizedPnl: 3,
              unrealizedR: 0.6,
              timeToTimeStopMs: 3600000
            }
          ]
        }
      });
      return;
    }

    if (path === "/admin/cascade/signals") {
      await route.fulfill({
        json: {
          ok: true,
          signals: [
            {
              signalId: "cascade-signal-1",
              instrumentCode: "btc-usd",
              action: "BUY",
              outcome: "TAKEN",
              createdAt: now
            }
          ]
        }
      });
      return;
    }

    if (path === "/admin/cascade/heat") {
      await route.fulfill({
        json: {
          ok: true,
          heat: {
            currentHeatPct: 0.005,
            heatCapPct: 0.02,
            percentOfCap: 0.25,
            openPositionCount: 1,
            remainingRiskUsd: 5,
            updatedAt: now
          }
        }
      });
      return;
    }

    if (path === "/admin/cascade/positions/cascade-position-1/close") {
      api.cascadeCloseCount += 1;
      await route.fulfill({ json: { ok: true } });
      return;
    }

    if (path === "/admin/backtest/cascade") {
      api.cascadeBacktestCount += 1;
      await route.fulfill({
        json: {
          ok: true,
          report: {
            schemaVersion: "cascade.backtest-report.v2",
            fromDate: now,
            toDate: now,
            instruments: ["btc-usd", "eth-usd", "sol-usd", "hype-usd"],
            startingEquity: 1000,
            endingEquity: 1003,
            totalPnl: 3,
            maxDrawdownPct: 0.001,
            trades: [],
            cascades: [],
            signals: [],
            rejectedSignals: [],
            dataQuality: {
              candleCount: 1000,
              liquidationCount: 20,
              openInterestCount: 100,
              slippageSampleCount: 10,
              source: "D1"
            },
            validation: {
              ok: true,
              checks: [
                {
                  id: "candles_present",
                  label: "Historical candles",
                  ok: true,
                  detail: "1000 candles loaded."
                },
                {
                  id: "liquidations_present",
                  label: "Historical liquidations",
                  ok: true,
                  detail: "20 liquidation events loaded."
                }
              ]
            },
            metadata: { model: "cascade-event-replay-v2" }
          }
        }
      });
      return;
    }

    if (path === "/admin/alerts") {
      await route.fulfill({
        json: { ok: true, alerting: { configured: false, debounceMs: 60000, channels: [] } }
      });
      return;
    }

    if (path === "/admin/settings") {
      await route.fulfill({
        json: {
          ok: true,
          config,
          notifications: {
            enabled: true,
            minPriority: "MEDIUM",
            debounceMs: 60000,
            textFrequencyMs: 300000,
            heartbeatDigestMinutes: 60,
            tradeAlertMode: "SUMMARY",
            telegramEnabled: false,
            discordEnabled: false,
            genericWebhookEnabled: false,
            quietHoursEnabled: false
          },
          alerting: { configured: false, debounceMs: 60000, channels: [] },
          vault: { entries: {}, rotationPolicy: "test" },
          backend: { execution: { shadowMode: "true" }, ingest: {} },
          costBudgets: {
            dailyBudgetUsd: 25,
            workersAiDailyBudgetUsd: 2,
            durableObjectDailyBudgetUsd: 10,
            d1DailyBudgetUsd: 5,
            workersAiCostPerCallUsd: 0,
            durableObjectCostPerMsUsd: 0,
            d1ReadCostPerQueryUsd: 0,
            d1WriteCostPerRowUsd: 0,
            enforcement: "BLOCK_LIVE"
          },
          strategyVault: { versions: [], active: null }
        }
      });
      return;
    }

    if (path === "/admin/live-readiness") {
      await route.fulfill({
        status: 409,
        json: {
          ok: false,
          readiness: {
            ok: false,
            generatedAt: now,
            checks: [
              {
                id: "shadow_mode_disabled",
                label: "Shadow Mode Disabled",
                ok: false,
                detail: "Worker is still in SHADOW_MODE."
              },
              {
                id: "quote_health",
                label: "Quote Health",
                ok: true,
                detail: "One quote-eligible paper asset."
              }
            ]
          }
        }
      });
      return;
    }

    if (path === "/admin/diagnostics") {
      api.diagnosticsCount += 1;
      await route.fulfill({
        json: {
          ok: true,
          generatedAt: now,
          checks: [
            {
              id: "l1_sync",
              label: "L1 Sync Check",
              status: "OPTIMAL",
              detail: "No dropped packets in the mocked visual path."
            }
          ]
        }
      });
      return;
    }

    if (path === "/admin/replay") {
      api.replayCount += 1;
      await route.fulfill({
        json: {
          ok: true,
          replay: {
            status: "COMPLETED",
            progressPct: 100,
            scenario: "BASELINE",
            theoreticalPnl: 2.1,
            maxDrawdown: 0.001,
            sharpe: 1.2
          }
        }
      });
      return;
    }

    if (path === "/admin/replay/status") {
      await route.fulfill({ json: { ok: true, replay: null } });
      return;
    }

    if (path === "/admin/execution-quality") {
      await route.fulfill({
        json: {
          ok: true,
          fillRate: { accepted: 1, filled: 1, fillRate: 1 },
          aggregate: {
            sampleCount: 1,
            averageSlippageBps: 0,
            adverseSelectionBps: 0,
            averageShortfall: 0,
            averageLatencyMs: 1,
            totalFees: 0
          },
          byAsset: []
        }
      });
      return;
    }

    if (path === "/admin/costs") {
      await route.fulfill({
        json: {
          ok: true,
          cost: {
            ok: true,
            totals: { estimatedUsd: 0 },
            budgets: {
              dailyBudgetUsd: 25,
              workersAiDailyBudgetUsd: 2,
              durableObjectDailyBudgetUsd: 10,
              d1DailyBudgetUsd: 5,
              workersAiCostPerCallUsd: 0,
              durableObjectCostPerMsUsd: 0,
              d1ReadCostPerQueryUsd: 0,
              d1WriteCostPerRowUsd: 0,
              enforcement: "BLOCK_LIVE"
            },
            violations: []
          }
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
    STRATEGY_MODE: "CASCADE_RECOVERY",
    ORACLE_ENABLED: true,
    SENTIMENT_ENABLED: true,
    PROFILER_ENABLED: true,
    CROUPIER_ENABLED: true,
    PIT_BOSS_ENABLED: true,
    MARKET_MAKING_MODE: "BALANCED",
    MAX_POSITION_SIZE: 1,
    MAX_POSITION_PCT: 0.05,
    MAX_INVENTORY_UNITS: 5,
    MAX_INVENTORY_DELTA: 1,
    MAX_DRAWDOWN_PCT: 0.2,
    LATENCY_THRESHOLD_MS: 2000,
    GOLDEN_COLOS: "NRT",
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
    AM_VPIN_CONTESTED_SPREAD_MULTIPLIER: 1,
    AM_VPIN_TOXIC_SPREAD_MULTIPLIER: 1,
    AM_VPIN_QUOTE_HALT_MS: 60000,
    CASCADE_WINDOW_MS: 900000,
    CASCADE_NOTIONAL_THRESHOLD_USD: 10000000,
    CASCADE_ZSCORE_THRESHOLD: 3,
    CASCADE_LOOKBACK_HOURS: 24,
    CASCADE_DIRECTIONAL_PCT: 0.75,
    CASCADE_MIN_PRICE_MOVE_ATR: 1,
    ABSORPTION_WINDOW_MS: 1800000,
    ABSORPTION_PRICE_BAND_BPS: 25,
    ABSORPTION_MIN_HOLD_SECONDS: 120,
    ENTRY_WINDOW_SECONDS: 1800,
    IMPULSIVE_BAR_BODY_ATR: 1.2,
    IMPULSIVE_BAR_VOLUME_MULT: 1.5,
    STOP_BUFFER_ATR: 0.25,
    MIN_STOP_DISTANCE_BPS: 15,
    MAX_STOP_DISTANCE_BPS: 350,
    MIN_TIME_SINCE_LAST_CASCADE_SECONDS: 900,
    NEWS_BLACKOUT_MINUTES: 30,
    MAX_REALIZED_VOL_PERCENTILE: 0.95,
    CASCADE_TIME_STOP_HOURS: 6,
    PARTIAL_1_R: 2,
    PARTIAL_1_SIZE_PCT: 30,
    PARTIAL_2_R: 3,
    PARTIAL_2_SIZE_PCT: 30,
    TRAILING_STOP_TYPE: "ATR",
    TRAILING_STOP_PARAM: 2,
    RISK_PER_TRADE_PCT: 0.005,
    HEAT_CAP_PCT: 0.02,
    MAX_POSITION_NOTIONAL_PCT: 0.1,
    ASSET_LIQUIDITY_CAP_USD: 25000,
    DAILY_LOSS_LIMIT_PCT: 0.02,
    WEEKLY_LOSS_LIMIT_PCT: 0.05,
    MAX_CONSECUTIVE_LOSSES: 3,
    HEDGE_ENABLED: false,
    HEDGE_TRIGGER_INVENTORY_PCT: 0.6,
    HEDGE_COOLDOWN_MS: 30000,
    HEDGE_MAX_SLIPPAGE_BPS: 8,
    CASCADE_TAKER_ENABLED: false,
    CASCADE_INSTRUMENTS: "BTC,ETH,SOL",
    MAX_SPREAD_BPS_FOR_TAKER: 15,
    MAX_SINGLE_ORDER_NOTIONAL_USD: 1000,
    SLICE_NOTIONAL_THRESHOLD_USD: 10000,
    SLICE_NOTIONAL_PER_CHUNK: 2500,
    SLICE_INTERVAL_MS: 250,
    SLICE_JITTER_MS: 50,
    MIN_FILL_RATIO: 0.8,
    LAYERED_QUOTE_LEVELS: 3,
    LAYERED_QUOTE_SIZE_DECAY: 0.55,
    LAYERED_QUOTE_SPREAD_STEP_BPS: 1,
    CVAR_CONFIDENCE: 0.99,
    CVAR_MAX_TAIL_LOSS_BPS: 25,
    CVAR_LOOKBACK_TRADES: 500,
    SENTIMENT_ALPHA_MODE: "EVENT_RISK_ONLY",
    TOXICITY_CLASSIFIER_ENABLED: true,
    TOXICITY_CLASSIFIER_THRESHOLD: 0.72,
    FUNDING_PRE_SETTLEMENT_WINDOW_MS: 1800000,
    FUNDING_PRE_SETTLEMENT_BIAS_MULTIPLIER: 2,
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
    riskMetrics: {
      highWaterMark: 1000,
      rollingDrawdownPct: 0,
      var99OneHour: 0,
      isTradingEnabled: true,
      updatedAt: now
    },
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
      "btc-usd": {
        instrumentCode: "btc-usd",
        coin: "BTC",
        active: true,
        selectedByMoltworker: true,
        capitalAllocationPct: 0.25,
        midPrice: 101
      },
      "eth-usd": {
        instrumentCode: "eth-usd",
        coin: "ETH",
        active: true,
        selectedByMoltworker: true,
        capitalAllocationPct: 0.25,
        midPrice: 2500
      }
    },
    profilerStates: {},
    microstructure: {
      bestBid: 100,
      bestAsk: 101,
      midPrice: 100.5,
      spreadBps: 10,
      weightedImbalance: 0.1,
      depthLevels: 20,
      timeToBookMs: 1,
      updatedAt: now
    },
    oracle: { skepticismMultiplier: 1.4 },
    inventory: {
      netDelta: 0,
      current_inventory_delta: 0,
      baseAsset: "BTC",
      normalization: {},
      maxInventoryUnits: 5,
      maxInventoryDelta: 1,
      inventoryPenalty: 0,
      stopBid: false,
      stopAsk: false
    },
    quoteState: { status: "ACTIVE", reason: null, suspendedUntil: null },
    executionProfile: {
      status: "STABLE",
      jitterMs: 1,
      jitterThresholdMs: 10,
      averageProcessingLatencyMs: 0,
      orderBookUpdateMs: 0,
      agentLogicMs: 0,
      wakeUpTimeMs: 0
    },
    citadel: {
      status: "NOMINAL",
      reason: null,
      shadowMode: true,
      lastEvacuationAt: null,
      updatedAt: now
    },
    location: {
      colo: "BRU",
      isGoldenRegion: true,
      latencyRiskMultiplier: 1,
      positionSizeMultiplier: 1
    },
    lastTradeIntent: null,
    orderMap: {},
    heartbeatAt: now,
    updatedAt: now
  };
}
