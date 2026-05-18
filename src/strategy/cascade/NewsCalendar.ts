export const CASCADE_NEWS_CALENDAR_KEY = "cascade_news_calendar";

export type NewsEventImpact = "LOW" | "MEDIUM" | "HIGH";

export interface NewsCalendarEvent {
  eventId: string;
  title: string;
  category: "FOMC" | "CPI" | "NFP" | "PCE" | "GDP" | "TOKEN_UNLOCK" | "LISTING" | "ETF" | "AD_HOC";
  impact: NewsEventImpact;
  startsAt: string;
  endsAt: string;
  assets: string[];
  source: "OPERATOR" | "CALENDAR_IMPORT" | "SYSTEM";
  createdAt: string;
  createdBy: string;
}

export interface NewsCalendarPayload {
  schemaVersion: "cascade.news-calendar.v1";
  events: NewsCalendarEvent[];
  updatedAt: string;
}

export interface NewsBlackoutDecision {
  blocked: boolean;
  reason?: string;
  event?: NewsCalendarEvent;
}

const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1_000;

export class NewsCalendar {
  private events: NewsCalendarEvent[] = [];
  private loadedAtMs = 0;

  constructor(private readonly kv: KVNamespace) {}

  async refresh(force = false): Promise<NewsCalendarPayload> {
    const nowMs = Date.now();
    if (!force && nowMs - this.loadedAtMs < REFRESH_INTERVAL_MS) {
      return this.snapshot();
    }

    const payload = await this.kv.get<NewsCalendarPayload>(CASCADE_NEWS_CALENDAR_KEY, "json");
    this.events = sanitizeEvents(payload?.events ?? []);
    this.loadedAtMs = nowMs;
    return this.snapshot();
  }

  async addAdHocBlackout(
    input: Pick<NewsCalendarEvent, "title" | "startsAt" | "endsAt" | "assets"> & {
      createdBy: string;
    }
  ): Promise<NewsCalendarPayload> {
    await this.refresh(true);
    const event: NewsCalendarEvent = {
      eventId: `ad-hoc-${crypto.randomUUID()}`,
      title: input.title,
      category: "AD_HOC",
      impact: "HIGH",
      startsAt: new Date(input.startsAt).toISOString(),
      endsAt: new Date(input.endsAt).toISOString(),
      assets: normalizeAssets(input.assets),
      source: "OPERATOR",
      createdAt: new Date().toISOString(),
      createdBy: input.createdBy
    };
    this.events = sanitizeEvents([...this.events, event]);
    const payload = this.snapshot();
    await this.kv.put(CASCADE_NEWS_CALENDAR_KEY, JSON.stringify(payload));
    return payload;
  }

  isWithinBlackout(at: Date, asset: string): NewsBlackoutDecision {
    const atMs = at.getTime();
    const normalizedAsset = normalizeAsset(asset);

    for (const event of this.events) {
      if (event.impact !== "HIGH") {
        continue;
      }

      const startsAtMs = Date.parse(event.startsAt);
      const endsAtMs = Date.parse(event.endsAt);
      if (!Number.isFinite(startsAtMs) || !Number.isFinite(endsAtMs)) {
        continue;
      }

      const assetBlocked =
        event.assets.length === 0 ||
        event.assets.includes("*") ||
        event.assets.includes(normalizedAsset);

      if (assetBlocked && atMs >= startsAtMs && atMs <= endsAtMs) {
        return {
          blocked: true,
          reason: event.title,
          event
        };
      }
    }

    return { blocked: false };
  }

  snapshot(): NewsCalendarPayload {
    return {
      schemaVersion: "cascade.news-calendar.v1",
      events: this.events.map((event) => ({ ...event, assets: [...event.assets] })),
      updatedAt: new Date(this.loadedAtMs || Date.now()).toISOString()
    };
  }
}

function sanitizeEvents(events: readonly NewsCalendarEvent[]): NewsCalendarEvent[] {
  return events
    .filter((event) => {
      const startsAtMs = Date.parse(event.startsAt);
      const endsAtMs = Date.parse(event.endsAt);
      return (
        typeof event.eventId === "string" &&
        typeof event.title === "string" &&
        Number.isFinite(startsAtMs) &&
        Number.isFinite(endsAtMs) &&
        endsAtMs >= startsAtMs
      );
    })
    .map((event) => ({
      ...event,
      impact: normalizeImpact(event.impact),
      assets: normalizeAssets(event.assets)
    }))
    .sort((left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt));
}

function normalizeImpact(value: string): NewsEventImpact {
  return value === "HIGH" || value === "MEDIUM" || value === "LOW" ? value : "LOW";
}

function normalizeAssets(assets: readonly string[]): string[] {
  return [...new Set(assets.map(normalizeAsset).filter((asset) => asset.length > 0))];
}

function normalizeAsset(asset: string): string {
  return asset.trim().toUpperCase();
}
