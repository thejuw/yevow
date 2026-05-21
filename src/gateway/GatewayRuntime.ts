import type { Context } from "hono";
import { ConfigManager, configDefaultsFromEnv } from "../ConfigManager";
import { Logger, createLogSink, structuredConsoleLogsEnabled } from "../Logger";
import { extractEdgeTopology } from "./Topology";
import type { EdgeTopology, Env } from "../types";

export type GatewayHono = { Bindings: Env };

export interface GatewayRuntime {
  logger: Logger;
  configManager: ConfigManager;
  topology: EdgeTopology;
}

export function gatewayRuntime(c: Context<GatewayHono>): GatewayRuntime {
  return {
    logger: new Logger(
      c.env.TRADING_DB,
      (promise) => c.executionCtx.waitUntil(promise),
      "GatewayWorker",
      undefined,
      createLogSink(c.env),
      structuredConsoleLogsEnabled(c.env)
    ),
    configManager: new ConfigManager(c.env.CONFIG_STORE, configDefaultsFromEnv(c.env)),
    topology: extractEdgeTopology(c.req.raw, c.env)
  };
}
