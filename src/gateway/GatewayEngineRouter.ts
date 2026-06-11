import { getTradingEngineStub } from "../utils/TradingEngineStub";
import type { EdgeTopology, Env } from "../types";
import { ENGINE_HEALTH_TIMEOUT_MS } from "./GatewayConstants";
import { json, withCors } from "./ResponseHelpers";
import { withTopologyHeaders } from "./Topology";

export function gatewayHealthFallback(topology: EdgeTopology): Response {
  return json(
    {
      ok: false,
      status: "ENGINE_HEALTH_TIMEOUT",
      service: "sovereign-sigma-core",
      message: "Trading engine health did not respond within the gateway timeout",
      timeoutMs: ENGINE_HEALTH_TIMEOUT_MS,
      topology,
      observedAt: new Date().toISOString()
    },
    503
  );
}

export function remapRequestPath(request: Request, pathname: string): Request {
  const url = new URL(request.url);
  url.pathname = pathname;
  return new Request(url, request);
}

export async function routeToEngine(
  request: Request,
  env: Env,
  topology: EdgeTopology,
  options: {
    timeoutMs?: number;
    timeoutResponse?: Response;
  } = {}
): Promise<Response> {
  const engine = getTradingEngineStub(env);
  const controller = options.timeoutMs ? new AbortController() : null;
  const timeout =
    controller && options.timeoutMs
      ? setTimeout(() => controller.abort("ENGINE_TIMEOUT"), options.timeoutMs)
      : null;

  try {
    const response = await engine.fetch(withTopologyHeaders(request, topology, controller?.signal));

    return response.status === 101 ? response : withCors(response);
  } catch (error) {
    if (controller?.signal.aborted && options.timeoutResponse) {
      return withCors(options.timeoutResponse);
    }

    throw error;
  } finally {
    if (timeout !== null) {
      clearTimeout(timeout);
    }
  }
}
