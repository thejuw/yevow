import type { Logger } from "../Logger";
import type { EdgeTopology, Env, JsonRecord } from "../types";
import { json } from "./ResponseHelpers";

interface PeFeedConfig {
  url: string;
  source?: string;
}

interface RssArticle {
  title: string;
  summary: string;
  source: string;
  url: string;
  publishedDate: string;
}

interface ExtractedDeal {
  buyer: string | null;
  target: string | null;
  deal_size: string | number | null;
  sector: string | null;
}

interface WorkersAiTextResult {
  response?: string;
  text?: string;
}

interface PeDealRow {
  id: string;
  published_date: string;
  buyer: string;
  target_company: string;
  deal_size: number | null;
  sector: string | null;
  source_url: string;
  created_at: string;
}

export interface PrivateEquityIngestResult {
  feedsFetched: number;
  articlesScanned: number;
  keywordMatches: number;
  aiAttempts: number;
  inserted: number;
  duplicates: number;
  skipped: number;
  failed: number;
}

const DEFAULT_PE_DEAL_MODEL = "@cf/meta/llama-3-8b-instruct";
const DEFAULT_FEEDS: PeFeedConfig[] = [
  {
    url: "https://www.prnewswire.com/rss/financial-services-latest-news/acquisitions-mergers-and-takeovers-list.rss",
    source: "PR Newswire M&A"
  },
  {
    url: "https://www.prnewswire.com/rss/financial-services-latest-news/financial-services-latest-news-list.rss",
    source: "PR Newswire Financial Services"
  },
  {
    url: "https://www.prnewswire.com/rss/news-releases-list.rss",
    source: "PR Newswire All News"
  }
];
const DEFAULT_KEYWORDS = [
  "private equity",
  "buyout",
  "acquired by",
  "majority stake",
  "take private",
  "acquires",
  "acquisition",
  "merger",
  "recapitalization"
];

export async function readPrivateEquityDeals(env: Env): Promise<Response> {
  const db = equityDb(env);

  if (!db) {
    return json({ ok: false, error: "EQUITY_DB binding is not configured" }, 503);
  }

  const result = await db
    .prepare(
      `SELECT
          id,
          published_date,
          buyer,
          target_company,
          deal_size,
          sector,
          source_url,
          created_at
       FROM pe_deals
       ORDER BY published_date DESC
       LIMIT 50`
    )
    .all<PeDealRow>();

  return json({
    ok: true,
    count: result.results.length,
    deals: result.results
  });
}

export async function handlePrivateEquityScheduled(
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
  logger: Logger,
  topology: EdgeTopology
): Promise<void> {
  if (env.PE_DEALS_ENABLED === "false") {
    logger.info("PE_DEALS_SCHEDULE_DISABLED", "Private equity deal cron skipped because disabled", {
      cron: controller.cron
    });
    return;
  }

  const scheduledAt = new Date(controller.scheduledTime);
  const timezone = env.PE_DEALS_SCHEDULER_TIMEZONE ?? "America/Chicago";
  const local = localTimeParts(scheduledAt, timezone);

  if (local.hour !== "00" || local.minute !== "00") {
    logger.info(
      "PE_DEALS_SCHEDULE_SKIPPED",
      "Private equity deal cron skipped outside local midnight",
      {
        cron: controller.cron,
        timezone,
        localDate: local.date,
        localTime: `${local.hour}:${local.minute}`
      }
    );
    return;
  }

  const idempotencyKey = `pe-deals:daily-ingest:${timezone}:${local.date}`;
  const existing = await env.CONFIG_STORE.get(idempotencyKey);

  if (existing) {
    logger.info("PE_DEALS_SCHEDULE_DEDUPED", "Private equity deal cron already ran", {
      idempotencyKey,
      existing,
      cron: controller.cron
    });
    return;
  }

  await env.CONFIG_STORE.put(idempotencyKey, new Date().toISOString(), {
    expirationTtl: 3 * 24 * 60 * 60
  });

  const ingest = ingestPrivateEquityDeals(env, logger, topology);
  ctx.waitUntil(ingest);
  const result = await ingest;

  logger.info("PE_DEALS_SCHEDULE_COMPLETED", "Private equity deal ingest completed", {
    ...result,
    cron: controller.cron,
    timezone,
    localDate: local.date
  });
}

export async function ingestPrivateEquityDeals(
  env: Env,
  logger: Logger,
  topology?: EdgeTopology
): Promise<PrivateEquityIngestResult> {
  const result: PrivateEquityIngestResult = {
    feedsFetched: 0,
    articlesScanned: 0,
    keywordMatches: 0,
    aiAttempts: 0,
    inserted: 0,
    duplicates: 0,
    skipped: 0,
    failed: 0
  };
  const db = equityDb(env);

  if (!db) {
    logger.error("PE_DEALS_DB_MISSING", "EQUITY_DB binding is not configured");
    return { ...result, failed: result.failed + 1 };
  }

  if (!env.AI) {
    logger.error("PE_DEALS_AI_MISSING", "Workers AI binding is not configured for PE extraction");
    return { ...result, failed: result.failed + 1 };
  }

  const feeds = loadPeFeeds(env);
  const keywords = loadKeywords(env);
  const maxItemsPerFeed = positiveInteger(env.PE_DEALS_MAX_ITEMS_PER_FEED, 25, 1, 100);
  const seenUrls = new Set<string>();

  for (const feed of feeds) {
    try {
      const response = await fetch(feed.url, {
        headers: {
          accept: "application/rss+xml, application/xml, text/xml",
          "user-agent": "YevowPrivateEquityBot/1.0 (+https://yevow.co/equity)"
        }
      });

      if (!response.ok) {
        result.failed += 1;
        logger.warn("PE_DEALS_FEED_FETCH_FAILED", "Private equity RSS feed returned non-2xx", {
          source: feed.source ?? feed.url,
          url: feed.url,
          status: response.status
        });
        continue;
      }

      result.feedsFetched += 1;
      const articles = parseRssArticles(await response.text(), feed).slice(0, maxItemsPerFeed);
      result.articlesScanned += articles.length;

      for (const article of articles) {
        if (seenUrls.has(article.url)) {
          result.duplicates += 1;
          continue;
        }

        seenUrls.add(article.url);

        if (!matchesKeywords(article, keywords)) {
          continue;
        }

        result.keywordMatches += 1;

        const alreadyStored = await hasDealSourceUrl(db, article.url);
        if (alreadyStored) {
          result.duplicates += 1;
          continue;
        }

        try {
          result.aiAttempts += 1;

          const extracted = await extractDealWithAi(env, article);
          const normalized = normalizeExtractedDeal(extracted);

          if (!normalized) {
            result.skipped += 1;
            logger.warn(
              "PE_DEALS_EXTRACTION_SKIPPED",
              "AI extraction did not produce a usable PE deal",
              {
                title: article.title,
                source: article.source,
                url: article.url
              }
            );
            continue;
          }

          const inserted = await insertPeDeal(db, {
            id: await dealId(article.url),
            publishedDate: article.publishedDate,
            buyer: normalized.buyer,
            targetCompany: normalized.targetCompany,
            dealSize: normalized.dealSize,
            sector: normalized.sector,
            sourceUrl: article.url
          });

          if (inserted) {
            result.inserted += 1;
            logger.info("PE_DEAL_INSERTED", "Inserted private equity deal from news feed", {
              buyer: normalized.buyer,
              targetCompany: normalized.targetCompany,
              sector: normalized.sector,
              dealSize: normalized.dealSize,
              source: article.source,
              sourceUrl: article.url,
              publishedDate: article.publishedDate,
              colo: topology?.colo ?? null
            });
          } else {
            result.duplicates += 1;
          }
        } catch (error) {
          result.failed += 1;
          logger.warn("PE_DEALS_ARTICLE_FAILED", "Failed to extract or insert PE deal article", {
            title: article.title,
            source: article.source,
            url: article.url,
            error: error instanceof Error ? error.message : "UNKNOWN_ERROR"
          });
        }
      }
    } catch (error) {
      result.failed += 1;
      logger.warn("PE_DEALS_FEED_INGEST_FAILED", "Failed to ingest private equity RSS feed", {
        source: feed.source ?? feed.url,
        url: feed.url,
        error: error instanceof Error ? error.message : "UNKNOWN_ERROR"
      });
    }
  }

  return result;
}

function equityDb(env: Env): D1Database | null {
  return env.EQUITY_DB ?? null;
}

function loadPeFeeds(env: Env): PeFeedConfig[] {
  const raw = env.PE_DEALS_FEEDS?.trim();

  if (!raw) {
    return DEFAULT_FEEDS;
  }

  const parsed = parseJson<Array<string | PeFeedConfig>>(raw);
  if (Array.isArray(parsed)) {
    const feeds = parsed.flatMap((entry) => {
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

    if (feeds.length > 0) {
      return feeds;
    }
  }

  const commaFeeds = raw
    .split(",")
    .map((url) => url.trim())
    .filter((url) => url.startsWith("http"))
    .map((url) => ({ url }));

  return commaFeeds.length > 0 ? commaFeeds : DEFAULT_FEEDS;
}

function loadKeywords(env: Env): string[] {
  const raw = env.PE_DEALS_KEYWORDS?.trim();

  if (!raw) {
    return DEFAULT_KEYWORDS;
  }

  const parsed = parseJson<string[]>(raw);
  const values = Array.isArray(parsed) ? parsed : raw.split(",");
  const keywords = values
    .map((keyword) => keyword.trim().toLowerCase())
    .filter((keyword) => keyword.length > 0);

  return keywords.length > 0 ? keywords : DEFAULT_KEYWORDS;
}

function parseRssArticles(xml: string, feed: PeFeedConfig): RssArticle[] {
  const itemMatches = [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)];
  const atomMatches = itemMatches.length === 0 ? [...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)] : [];
  const matches = itemMatches.length > 0 ? itemMatches : atomMatches;
  const source = feed.source ?? hostnameOf(feed.url);

  return matches.flatMap((match) => {
    const itemXml = match[0];
    const title = stripHtml(decodeXml(readXmlTag(itemXml, "title") ?? ""));

    if (!title) {
      return [];
    }

    const rawUrl =
      decodeXml(readXmlTag(itemXml, "link") ?? "") ||
      decodeXml(readXmlAttribute(itemXml, "link", "href") ?? "") ||
      decodeXml(readXmlTag(itemXml, "guid") ?? "");
    const url = normalizeUrl(rawUrl, feed.url);

    if (!url) {
      return [];
    }

    const summary = stripHtml(
      decodeXml(
        readXmlTag(itemXml, "description") ??
          readXmlTag(itemXml, "summary") ??
          readXmlTag(itemXml, "content:encoded") ??
          ""
      )
    );
    const publishedDate =
      normalizeDate(
        readXmlTag(itemXml, "pubDate") ??
          readXmlTag(itemXml, "published") ??
          readXmlTag(itemXml, "updated")
      ) ?? new Date().toISOString();

    return [
      {
        title,
        summary,
        source,
        url,
        publishedDate
      }
    ];
  });
}

function matchesKeywords(article: RssArticle, keywords: string[]): boolean {
  const haystack = `${article.title} ${article.summary}`.toLowerCase();
  return keywords.some((keyword) => haystack.includes(keyword));
}

async function hasDealSourceUrl(db: D1Database, sourceUrl: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT id FROM pe_deals WHERE source_url = ? LIMIT 1")
    .bind(sourceUrl)
    .first<{ id: string }>();
  return Boolean(row?.id);
}

async function extractDealWithAi(env: Env, article: RssArticle): Promise<ExtractedDeal | null> {
  const model = env.PE_DEALS_AI_MODEL ?? DEFAULT_PE_DEAL_MODEL;
  const result = (await env.AI?.run(model, {
    messages: [
      {
        role: "system",
        content:
          "You extract private equity M&A deal data. Return exactly one JSON object and no markdown. Required keys: buyer, target, deal_size, sector. Use null when unknown. buyer is the private equity firm or sponsor. target is the acquired company. deal_size is the disclosed transaction value as written, or null. sector is a concise industry sector."
      },
      {
        role: "user",
        content: [
          `Headline: ${article.title}`,
          `Summary: ${article.summary || "(none)"}`,
          `Published: ${article.publishedDate}`,
          `Source URL: ${article.url}`
        ].join("\n")
      }
    ],
    max_tokens: 256,
    temperature: 0
  })) as WorkersAiTextResult | undefined;

  return parseExtractedDeal(result?.response ?? result?.text ?? "");
}

function parseExtractedDeal(text: string): ExtractedDeal | null {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  const jsonText = cleaned.match(/\{[\s\S]*\}/)?.[0] ?? cleaned;
  const parsed = parseJson<unknown>(jsonText);

  if (!isRecord(parsed)) {
    return null;
  }

  return {
    buyer: nullableText(parsed.buyer),
    target: nullableText(parsed.target),
    deal_size:
      typeof parsed.deal_size === "number" || typeof parsed.deal_size === "string"
        ? parsed.deal_size
        : null,
    sector: nullableText(parsed.sector)
  };
}

function normalizeExtractedDeal(
  extracted: ExtractedDeal | null
): { buyer: string; targetCompany: string; dealSize: number | null; sector: string | null } | null {
  const buyer = normalizeRequiredName(extracted?.buyer);
  const targetCompany = normalizeRequiredName(extracted?.target);

  if (!buyer || !targetCompany) {
    return null;
  }

  return {
    buyer,
    targetCompany,
    dealSize: normalizeDealSize(extracted?.deal_size ?? null),
    sector: normalizeOptionalText(extracted?.sector)
  };
}

async function insertPeDeal(
  db: D1Database,
  deal: {
    id: string;
    publishedDate: string;
    buyer: string;
    targetCompany: string;
    dealSize: number | null;
    sector: string | null;
    sourceUrl: string;
  }
): Promise<boolean> {
  const observedAt = new Date().toISOString();
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO pe_deals
        (id, published_date, buyer, target_company, deal_size, sector, source_url, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      deal.id,
      deal.publishedDate,
      deal.buyer,
      deal.targetCompany,
      deal.dealSize,
      deal.sector,
      deal.sourceUrl,
      observedAt
    )
    .run();

  return Number(result.meta.changes ?? 0) > 0;
}

async function dealId(sourceUrl: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sourceUrl));
  const bytes = [...new Uint8Array(digest)].slice(0, 16);
  return `pe_deal_${bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function normalizeDealSize(value: string | number | null): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }

  if (typeof value !== "string") {
    return null;
  }

  const lower = value.toLowerCase();
  if (!lower || /\b(n\/a|na|unknown|undisclosed|not disclosed|none|null)\b/.test(lower)) {
    return null;
  }

  const match = lower.replace(/,/g, "").match(/([0-9]+(?:\.[0-9]+)?)/);
  if (!match) {
    return null;
  }

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) {
    return null;
  }

  if (/\b(billion|bn|b)\b/.test(lower)) {
    return amount * 1_000_000_000;
  }

  if (/\b(million|mn|mm|m)\b/.test(lower)) {
    return amount * 1_000_000;
  }

  if (/\b(thousand|k)\b/.test(lower)) {
    return amount * 1_000;
  }

  return amount;
}

function readXmlTag(xml: string, tag: string): string | null {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = xml.match(new RegExp(`<${escapedTag}[^>]*>([\\s\\S]*?)<\\/${escapedTag}>`, "i"));
  return match?.[1]?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim() ?? null;
}

function readXmlAttribute(xml: string, tag: string, attribute: string): string | null {
  const tagMatch = xml.match(new RegExp(`<${tag}\\b[^>]*>`, "i"));
  if (!tagMatch) {
    return null;
  }

  const attrMatch = tagMatch[0].match(new RegExp(`${attribute}=["']([^"']+)["']`, "i"));
  return attrMatch?.[1] ?? null;
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .trim();
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeUrl(rawUrl: string, baseUrl: string): string | null {
  try {
    return new URL(rawUrl, baseUrl).toString();
  } catch {
    return null;
  }
}

function normalizeDate(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const timestamp = Date.parse(decodeXml(value));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function localTimeParts(date: Date, timezone: string): { date: string; hour: string; minute: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "00";

  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    hour: part("hour"),
    minute: part("minute")
  };
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function normalizeRequiredName(value: string | null | undefined): string | null {
  const normalized = normalizeOptionalText(value);

  if (!normalized || /^(unknown|n\/a|na|null|none)$/i.test(normalized)) {
    return null;
  }

  return normalized;
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length > 0 ? trimmed.slice(0, 240) : null;
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unknown";
  }
}

function parseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
