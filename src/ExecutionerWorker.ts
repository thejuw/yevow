import { Logger, createLogSink, structuredConsoleLogsEnabled } from "./Logger";
import {
  cancelAllOrders,
  cancelOrder,
  executeIntent,
  executionerDiagnostics,
  getAccountBalance,
  json,
  listOpenOrders
} from "./execution/ExecutionerRuntime";
import { isShadowMode } from "./utils/CitadelProtocol";
import type { Env } from "./types";

export { __test__ } from "./execution/ExecutionerRuntime";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const logger = new Logger(
      env.TRADING_DB,
      (promise) => ctx.waitUntil(promise),
      "ExecutionerWorker",
      undefined,
      createLogSink(env),
      structuredConsoleLogsEnabled(env)
    );
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({
        ok: true,
        service: "sovereign-sigma-executioner",
        shadowMode: isShadowMode(env)
      });
    }

    if (url.pathname === "/diagnostics") {
      return executionerDiagnostics(env);
    }

    if (request.method === "POST" && url.pathname === "/execute") {
      return executeIntent(request, env, ctx, logger);
    }

    if (request.method === "POST" && url.pathname === "/cancel") {
      return cancelOrder(request, env, ctx, logger);
    }

    if (request.method === "POST" && url.pathname === "/cancel-all") {
      return cancelAllOrders(request, env, ctx, logger);
    }

    if (request.method === "GET" && url.pathname === "/open-orders") {
      return listOpenOrders(env, logger);
    }

    if (request.method === "GET" && url.pathname === "/account/balance") {
      return getAccountBalance(env, logger);
    }

    return json({ ok: false, error: "Not found" }, 404);
  }
} satisfies ExportedHandler<Env>;
