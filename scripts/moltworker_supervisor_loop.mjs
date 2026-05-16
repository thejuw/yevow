#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const DEFAULT_GATEWAY_URL = "https://api.yevow.co";
const DEFAULT_INTERVAL_MS = 60_000;
const MIN_INTERVAL_MS = 5_000;

const gatewayUrl = normalizeUrl(process.env.MOLTWORKER_GATEWAY_URL ?? DEFAULT_GATEWAY_URL);
const password = process.env.MOLTWORKER_ADMIN_PASSWORD ?? process.env.ADMIN_PASSWORD;
const subject = process.env.MOLTWORKER_SUBJECT ?? "local-openclaw-supervisor";
const mode = process.env.MOLTWORKER_MODE ?? "AUTONOMOUS";
const strategicIntent =
  process.env.MOLTWORKER_STRATEGIC_INTENT ??
  "Localized OpenClaw supervisor loop polling Sovereign-Sigma telemetry.";
const localDirectory = path.resolve(process.env.MOLTWORKER_LOCAL_DIRECTORY ?? process.cwd());
const once = readBoolean(process.env.MOLTWORKER_ONCE);
const intervalMs = Math.max(
  MIN_INTERVAL_MS,
  readPositiveInteger(process.env.MOLTWORKER_INTERVAL_MS, DEFAULT_INTERVAL_MS)
);

if (!password) {
  console.error("MOLTWORKER_ADMIN_PASSWORD or ADMIN_PASSWORD must be set.");
  process.exit(1);
}

let exitRequested = false;
process.on("SIGINT", () => {
  exitRequested = true;
});
process.on("SIGTERM", () => {
  exitRequested = true;
});

do {
  const result = await runHeartbeat();
  console.log(JSON.stringify(result));

  if (once || exitRequested) {
    process.exit(result.ok ? 0 : 1);
  }

  await sleep(intervalMs);
} while (!exitRequested);

async function runHeartbeat() {
  const startedAt = performance.now();
  const observedAt = new Date().toISOString();

  try {
    const login = await postJson(`${gatewayUrl}/login`, {
      password,
      subject,
      scopes: ["READ", "WRITE"]
    });

    if (!login.response.ok || typeof login.body?.token !== "string") {
      return {
        ok: false,
        observedAt,
        status: "LOGIN_FAILED",
        httpStatus: login.response.status,
        latencyMs: elapsedMs(startedAt)
      };
    }

    const heartbeat = await postJson(
      `${gatewayUrl}/admin/moltworker/heartbeat`,
      {
        status: "OK",
        mode,
        strategicIntent,
        metadata: {
          source: "local-openclaw-supervisor",
          runtime: "local-openclaw-sandbox",
          localDirectory,
          hostname: os.hostname(),
          platform: process.platform,
          nodeVersion: process.version,
          pid: process.pid,
          gitHead: gitHead(localDirectory)
        }
      },
      login.body.token
    );

    return {
      ok: heartbeat.response.ok,
      observedAt,
      status: heartbeat.response.ok ? "OK" : "HEARTBEAT_FAILED",
      httpStatus: heartbeat.response.status,
      gatewayUrl,
      runtime: "local-openclaw-sandbox",
      localDirectory,
      latencyMs: elapsedMs(startedAt)
    };
  } catch (error) {
    return {
      ok: false,
      observedAt,
      status: "SUPERVISOR_LOOP_ERROR",
      error: error instanceof Error ? error.message : "UNKNOWN_ERROR",
      gatewayUrl,
      latencyMs: elapsedMs(startedAt)
    };
  }
}

async function postJson(url, body, token) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  return {
    response,
    body: text ? safeJsonParse(text) : null
  };
}

function gitHead(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return null;
  }
}

function normalizeUrl(value) {
  return value.replace(/\/+$/, "");
}

function readBoolean(value) {
  return value === "1" || value === "true" || value === "TRUE";
}

function readPositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

function elapsedMs(startedAt) {
  return Math.round((performance.now() - startedAt) * 1000) / 1000;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
