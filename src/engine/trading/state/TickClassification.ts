import type { MarketTick } from "../../../types";

export function isInformationalTick(tick: MarketTick): boolean {
  const eventType = typeof tick.raw?.eventType === "string" ? tick.raw.eventType.toLowerCase() : "";
  const commodity = typeof tick.raw?.commodity === "string" ? tick.raw.commodity.toUpperCase() : "";

  return (
    eventType === "trade" ||
    eventType === "funding" ||
    eventType === "book-snapshot" ||
    commodity === "TRADE" ||
    commodity === "FUNDING"
  );
}

export function isTradeTick(tick: MarketTick): boolean {
  const eventType = typeof tick.raw?.eventType === "string" ? tick.raw.eventType.toLowerCase() : "";
  const commodity = typeof tick.raw?.commodity === "string" ? tick.raw.commodity.toUpperCase() : "";

  return eventType === "trade" || commodity === "TRADE";
}

export function extractTickStreamId(tick: MarketTick): string | null {
  const direct = tick.streamId?.trim();
  if (direct) {
    return direct;
  }

  const rawStreamId = tick.raw?.streamId;
  return typeof rawStreamId === "string" && rawStreamId.trim() ? rawStreamId.trim() : null;
}
