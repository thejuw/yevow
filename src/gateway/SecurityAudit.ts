import type { Logger } from "../Logger";
import type { EdgeTopology, JsonRecord } from "../types";

export function logSecurityEvent(
  logger: Logger,
  eventType: string,
  message: string,
  request: Request,
  url: URL,
  topology: EdgeTopology,
  extra: JsonRecord = {}
): void {
  logger.warn(eventType, message, {
    ...extra,
    sourceIp: sourceIp(request),
    endpoint: url.pathname,
    method: request.method,
    colo: topology.colo,
    placement: topology.placement,
    requestId: topology.requestId
  });
}

export function maskTokenId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 6)}...${value.slice(-4)}` : "configured";
}

export function sourceIp(request: Request): string | null {
  const forwardedFor = request.headers.get("x-forwarded-for");

  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-real-ip") ??
    forwardedFor?.split(",")[0]?.trim() ??
    null
  );
}
