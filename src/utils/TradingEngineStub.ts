import type { Env } from "../types";

const DEFAULT_ENGINE_OBJECT_NAME = "sovereign-sigma:singleton:trading-engine:v3:apac-tokyo";
const LOCATION_HINTS = new Set([
  "wnam",
  "enam",
  "sam",
  "weur",
  "eeur",
  "apac",
  "oc",
  "afr",
  "me"
]);

export function tradingEngineObjectName(env: Env): string {
  const configured = env.ENGINE_OBJECT_NAME?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_ENGINE_OBJECT_NAME;
}

export function tradingEngineLocationHint(
  env: Env
): DurableObjectNamespaceGetDurableObjectOptions | undefined {
  return durableObjectLocationOptions(env.ENGINE_LOCATION_HINT);
}

export function durableObjectLocationOptions(
  hint: string | undefined
): DurableObjectNamespaceGetDurableObjectOptions | undefined {
  const configured = hint?.trim().toLowerCase();

  if (!configured || !LOCATION_HINTS.has(configured)) {
    return undefined;
  }

  return {
    locationHint: configured as DurableObjectLocationHint
  };
}

export function getTradingEngineStub(env: Env): DurableObjectStub {
  const id = env.TRADING_ENGINE.idFromName(tradingEngineObjectName(env));
  return env.TRADING_ENGINE.get(id, tradingEngineLocationHint(env));
}
