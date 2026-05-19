import type { Logger } from "../Logger";
import type { Env } from "../types";
import { getTradingEngineStub } from "../utils/TradingEngineStub";

interface NewsFeedConfig {
  url: string;
  source?: string;
}

interface NewsItem {
  id: string;
  headline: string;
  source: string;
  url: string | null;
  publishedAt: string | null;
}

const seenNewsItems = new Map<string, number>();

export async function ingestNewsFeeds(env: Env, logger: Logger): Promise<void> {
  const feeds = loadNewsFeedConfigs(env);

  if (feeds.length === 0) {
    return;
  }

  pruneSeenNewsItems();

  for (const feed of feeds) {
    try {
      const response = await fetch(feed.url, {
        headers: { accept: "application/rss+xml, application/xml, text/xml" }
      });

      if (!response.ok) {
        logger.warn("NEWS_FEED_FETCH_FAILED", "News feed returned non-2xx status", {
          source: feed.source ?? feed.url,
          url: feed.url,
          status: response.status
        });
        continue;
      }

      const items = parseRssItems(await response.text(), feed);

      for (const item of items) {
        if (seenNewsItems.has(item.id)) {
          continue;
        }

        seenNewsItems.set(item.id, Date.now());
        await forwardNewsItem(env, item);
        logger.info("NEWS_ITEM_FORWARDED", "Forwarded attributed news item to sentiment agent", {
          source: item.source,
          headline: item.headline,
          url: item.url,
          publishedAt: item.publishedAt
        });
      }
    } catch (error) {
      logger.warn("NEWS_FEED_INGEST_FAILED", "Failed to ingest configured news feed", {
        source: feed.source ?? feed.url,
        url: feed.url,
        error: error instanceof Error ? error.message : "UNKNOWN_ERROR"
      });
    }
  }
}

async function forwardNewsItem(env: Env, item: NewsItem): Promise<void> {
  const engine = getTradingEngineStub(env);

  await engine.fetch(
    new Request("https://trading-engine.internal/news/sentiment", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-source": "sovereign-sigma-ingest-news"
      },
      body: JSON.stringify(item)
    })
  );
}

function loadNewsFeedConfigs(env: Env): NewsFeedConfig[] {
  const parsed = env.NEWS_FEEDS ? parseJson<Array<string | NewsFeedConfig>>(env.NEWS_FEEDS) : null;

  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.flatMap((entry) => {
    if (typeof entry === "string" && entry.startsWith("http")) {
      return [{ url: entry }];
    }

    if (isRecord(entry) && typeof entry.url === "string" && entry.url.startsWith("http")) {
      return [
        {
          url: entry.url,
          source: typeof entry.source === "string" ? entry.source : undefined
        }
      ];
    }

    return [];
  });
}

function parseRssItems(xml: string, feed: NewsFeedConfig): NewsItem[] {
  return [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].slice(0, 25).flatMap((match) => {
    const itemXml = match[0];
    const headline = decodeXml(readXmlTag(itemXml, "title") ?? "");

    if (!headline) {
      return [];
    }

    const url = decodeXml(readXmlTag(itemXml, "link") ?? "") || null;
    const guid = decodeXml(readXmlTag(itemXml, "guid") ?? "") || url || headline;
    const publishedAt = coerceTimestamp(readXmlTag(itemXml, "pubDate")) ?? null;

    return [
      {
        id: hashNewsId(`${feed.url}:${guid}`),
        headline,
        source: feed.source ?? hostnameOf(feed.url),
        url,
        publishedAt
      }
    ];
  });
}

function readXmlTag(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match?.[1]?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim() ?? null;
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function hashNewsId(value: string): string {
  return `news:${hashSequenceId(value)}`;
}

function pruneSeenNewsItems(): void {
  const cutoff = Date.now() - 24 * 60 * 60 * 1_000;

  for (const [id, observedAtMs] of seenNewsItems.entries()) {
    if (observedAtMs < cutoff) {
      seenNewsItems.delete(id);
    }
  }
}

function hashSequenceId(value: string): number {
  let hash = 2_166_136_261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }

  return hash >>> 0;
}

function coerceTimestamp(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }

  if (isRecord(value) && typeof value.value === "string") {
    return value.value;
  }

  return null;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unknown";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}
