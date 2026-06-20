import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";

const USER_AGENT = "YevowPrivateEquityBot/1.0 (+https://yevow.co/equity)";
const GDELT_ENDPOINT = "https://api.gdeltproject.org/api/v2/doc/doc";
const START_DATE = process.env.PE_BACKFILL_START ?? `${new Date().getUTCFullYear()}-01-01`;
const END_DATE = process.env.PE_BACKFILL_END ?? new Date().toISOString().slice(0, 10);
const MAX_RECORDS = Number(process.env.PE_BACKFILL_MAX_RECORDS ?? 120);
const MAX_ARTICLES = Number(process.env.PE_BACKFILL_MAX_ARTICLES ?? 700);
const USE_MONTHLY_WINDOWS = process.env.PE_BACKFILL_MONTHLY === "true";
const ARTICLE_FETCH_CONCURRENCY = Number(process.env.PE_BACKFILL_FETCH_CONCURRENCY ?? 8);
const APPLY_REMOTE = process.env.PE_BACKFILL_APPLY !== "false";
const OUT_DIR = path.resolve("tmp");
const SQL_PATH = path.join(OUT_DIR, "pe_deals_ytd_backfill.sql");
const JSON_PATH = path.join(OUT_DIR, "pe_deals_ytd_backfill.json");

const queries = [
  '"private equity" "acquires"',
  '"private equity" "acquired"',
  '"private equity firm" "acquired"',
  '"portfolio company" "acquires"',
  '"portfolio company" "acquired"',
  '"backed" "acquires" "private equity"',
  '"backed" "acquired" "private equity"',
  '"majority stake" "private equity"',
  '"majority investment" "private equity"',
  '"recapitalization" "private equity"'
];

const sectorRules = [
  ["Healthcare", /\b(healthcare|health care|medical|biotech|pharma|pharmaceutical|hospital|clinical|dental|veterinary|life sciences?)\b/i],
  ["Software", /\b(software|saas|cloud|cybersecurity|data platform|enterprise technology|AI|artificial intelligence)\b/i],
  ["Technology", /\b(technology|semiconductor|electronics|digital|IT services|managed services)\b/i],
  ["Industrial", /\b(industrial|manufacturing|aerospace|defense|metal|forging|packaging|automation)\b/i],
  ["Energy", /\b(energy|oil|gas|renewable|solar|power|utilities|critical materials)\b/i],
  ["Financial Services", /\b(financial services|wealth|insurance|asset management|payments|fintech|banking)\b/i],
  ["Business Services", /\b(business services|professional services|consulting|marketing|workforce|human capital|facility services)\b/i],
  ["Consumer", /\b(consumer|retail|food|beverage|restaurant|beauty|apparel|home services)\b/i],
  ["Infrastructure", /\b(infrastructure|transportation|logistics|construction|engineering|environmental|water)\b/i],
  ["Education", /\b(education|learning|training|school)\b/i]
];

function gdeltDate(value, endOfDay = false) {
  return `${value.replaceAll("-", "")}${endOfDay ? "235959" : "000000"}`;
}

function monthWindows(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T23:59:59.999Z`);
  const windows = [];
  let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));

  while (cursor <= end) {
    const windowStart = cursor < start ? start : new Date(cursor);
    const nextMonth = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    const windowEnd = new Date(Math.min(nextMonth.getTime() - 1, end.getTime()));
    windows.push({
      start: windowStart.toISOString().slice(0, 10),
      end: windowEnd.toISOString().slice(0, 10)
    });
    cursor = nextMonth;
  }

  return windows;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const windows = USE_MONTHLY_WINDOWS
    ? monthWindows(START_DATE, END_DATE)
    : [{ start: START_DATE, end: END_DATE }];
  const discovered = new Map();
  let gdeltCalls = 0;

  for (const window of windows) {
    for (const query of queries) {
      if (discovered.size >= MAX_ARTICLES) {
        break;
      }

      const articles = await searchGdelt(query, window);
      gdeltCalls += 1;

      for (const article of articles) {
        if (discovered.size >= MAX_ARTICLES) {
          break;
        }

        if (article.language !== "English" || !article.url || !article.title) {
          continue;
        }

        const url = normalizeUrl(article.url);
        if (!url || discovered.has(url)) {
          continue;
        }

        discovered.set(url, {
          title: normalizeTitle(article.title),
          url,
          publishedDate: gdeltSeenDate(article.seendate),
          domain: article.domain ?? hostnameOf(url)
        });
      }

      await sleep(350);
    }
  }

  const enrichedArticles = await mapWithConcurrency(
    [...discovered.values()],
    Math.max(1, ARTICLE_FETCH_CONCURRENCY),
    fetchArticleMetadata
  );
  const deals = enrichedArticles.map(extractDeal).filter(Boolean);
  const fetched = enrichedArticles.filter((article) => article.fetched).length;
  const skipped = enrichedArticles.length - deals.length;

  const uniqueDeals = dedupeDeals(deals);
  const sql = buildSql(uniqueDeals);
  await writeFile(SQL_PATH, sql);
  await writeFile(JSON_PATH, `${JSON.stringify(uniqueDeals, null, 2)}\n`);

  let wranglerOutput = "";
  if (APPLY_REMOTE && uniqueDeals.length > 0) {
    wranglerOutput = execFileSync(
      "npx",
      ["wrangler", "d1", "execute", "EQUITY_DB", "--remote", "--file", SQL_PATH],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
  }

  console.log(
    JSON.stringify(
      {
        startDate: START_DATE,
        endDate: END_DATE,
        monthlyWindows: USE_MONTHLY_WINDOWS,
        gdeltCalls,
        discoveredArticles: discovered.size,
        fetchedArticlePages: fetched,
        extractedDeals: deals.length,
        insertedOrDuplicateProtectedDeals: uniqueDeals.length,
        skipped,
        sqlPath: SQL_PATH,
        jsonPath: JSON_PATH,
        appliedRemote: APPLY_REMOTE,
        wranglerSummary: wranglerOutput
          .split("\n")
          .filter((line) => /changes|Executed|success|rows_written/.test(line))
          .slice(-8)
      },
      null,
      2
    )
  );
}

async function searchGdelt(query, window) {
  const url = new URL(GDELT_ENDPOINT);
  url.searchParams.set("query", query);
  url.searchParams.set("mode", "ArtList");
  url.searchParams.set("format", "json");
  url.searchParams.set("maxrecords", String(MAX_RECORDS));
  url.searchParams.set("sort", "DateDesc");
  url.searchParams.set("startdatetime", gdeltDate(window.start));
  url.searchParams.set("enddatetime", gdeltDate(window.end, true));

  try {
    const response = await fetchWithTimeout(url, 35_000);
    if (!response.ok) {
      return [];
    }

    const data = await response.json();
    return Array.isArray(data?.articles) ? data.articles : [];
  } catch {
    return [];
  }
}

async function fetchArticleMetadata(article) {
  try {
    const response = await fetchWithTimeout(article.url, 18_000);
    if (!response.ok) {
      return { ...article, fetched: false, description: "", keywords: [], sector: null };
    }

    const html = await response.text();
    const meta = extractHtmlMetadata(html);
    return {
      ...article,
      title: normalizeTitle(meta.title ?? article.title),
      canonicalUrl: normalizeUrl(meta.canonicalUrl) ?? article.url,
      publishedDate: meta.publishedDate ?? article.publishedDate,
      description: meta.description ?? "",
      keywords: meta.keywords,
      sector: meta.sector,
      fetched: true
    };
  } catch {
    return { ...article, fetched: false, description: "", keywords: [], sector: null };
  }
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7",
        "user-agent": USER_AGENT
      },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

function extractHtmlMetadata(html) {
  const jsonLd = extractJsonLd(html);
  const title =
    meta(html, "property", "og:title") ??
    meta(html, "name", "twitter:title") ??
    tagText(html, "title") ??
    jsonLd.title ??
    jsonLd.headline;
  const description =
    meta(html, "property", "og:description") ??
    meta(html, "name", "description") ??
    meta(html, "name", "twitter:description") ??
    jsonLd.description;
  const publishedDate =
    meta(html, "property", "article:published_time") ??
    jsonLd.datePublished ??
    jsonLd.dateCreated;
  const canonicalUrl = linkHref(html, "canonical") ?? meta(html, "property", "og:url");
  const keywords = [
    ...splitKeywords(meta(html, "name", "keywords")),
    ...splitKeywords(jsonLd.keywords)
  ];
  const sector = firstText(jsonLd.articleSection);

  return {
    title: cleanText(title ?? ""),
    description: cleanText(description ?? ""),
    publishedDate: normalizeDate(publishedDate),
    canonicalUrl,
    keywords,
    sector: normalizeSector(sector, `${title ?? ""} ${description ?? ""} ${keywords.join(" ")}`)
  };
}

function extractJsonLd(html) {
  const scripts = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const merged = {};

  for (const script of scripts) {
    const raw = decodeHtml(script[1]).trim();
    const parsed = safeJson(raw);
    const nodes = [];

    if (Array.isArray(parsed)) {
      nodes.push(...parsed);
    } else if (parsed && typeof parsed === "object") {
      if (Array.isArray(parsed["@graph"])) {
        nodes.push(...parsed["@graph"]);
      }
      nodes.push(parsed);
    }

    for (const node of nodes) {
      if (!node || typeof node !== "object") {
        continue;
      }
      const type = Array.isArray(node["@type"]) ? node["@type"].join(" ") : node["@type"];
      if (/Article|NewsArticle|BlogPosting|WebPage/i.test(String(type ?? ""))) {
        Object.assign(merged, node);
      }
    }
  }

  return merged;
}

function extractDeal(article) {
  const title = normalizeTitle(article.title);
  const description = cleanText(article.description ?? "");
  const keywords = (article.keywords ?? []).join(" ");
  const evidence = `${title}. ${description}. ${keywords}. ${article.domain ?? ""}`;

  if (!isPrivateEquityRelated(evidence)) {
    return null;
  }

  const candidates = [title, firstSentence(description)].filter(Boolean);
  for (const candidate of candidates) {
    const parsed = parseDealSentence(candidate);
    if (!parsed) {
      continue;
    }

    const buyer = normalizeEntity(parsed.buyer);
    const targetCompany = normalizeEntity(parsed.target);

    if (!buyer || !targetCompany || buyer === targetCompany) {
      continue;
    }

    if (isBadEntity(buyer) || isBadEntity(targetCompany)) {
      continue;
    }

    return {
      id: dealId(article.canonicalUrl ?? article.url),
      published_date: article.publishedDate,
      buyer,
      target_company: targetCompany,
      deal_size: extractDealSize(evidence),
      sector: normalizeSector(article.sector, evidence),
      source_url: article.canonicalUrl ?? article.url,
      created_at: new Date().toISOString()
    };
  }

  return null;
}

function parseDealSentence(sentence) {
  const value = normalizeTitle(sentence)
    .replace(/\s+-\s+Backed\b/gi, "-Backed")
    .replace(/\s+-\s+backed\b/gi, "-backed")
    .replace(/\s+:\s+/g, ": ")
    .replace(/^[A-Z][A-Za-z]+(?:\.com|wire|news)?\s*:\s*/i, "");

  const patterns = [
    /^(?<buyer>.+?\b[Bb]acked\s+.+?)\s+(?:acquires|acquired|completes acquisition of|announces acquisition of|buys)\s+(?<target>.+)$/i,
    /^(?<target>.+?)(?:,\s+.*?)?\s+(?:is|was|will be|to be|being)\s+(?:acquired|purchased|bought)\s+by\s+(?:private equity firm\s+)?(?<buyer>.+?)(?:\s+in\s+a?\s*\$|\s+for\s+\$|\.|$)/i,
    /^(?<buyer>.+?)\s+(?:acquires|acquired|completes acquisition of|announces acquisition of|announces the acquisition of|enters into (?:a )?(?:definitive )?agreement to acquire|to acquire|to buy|buys)\s+(?<target>.+)$/i,
    /^(?<target>.+?)\s+(?:is\s+)?(?:acquired|to be acquired)\s+by\s+(?<buyer>.+)$/i,
    /^(?<buyer>.+?)\s+(?:agrees to acquire|agreed to acquire|will acquire)\s+(?:a\s+)?(?:majority\s+stake\s+in\s+)?(?<target>.+)$/i,
    /^(?<buyer>.+?)\s+(?:takes|takes a|acquires|secures|makes)\s+(?:majority|strategic|growth)\s+(?:stake|investment)\s+in\s+(?<target>.+)$/i,
    /^(?<buyer>.+?)\s+(?:invests in|invests into)\s+(?<target>.+)$/i
  ];

  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match?.groups?.buyer && match.groups.target) {
      return match.groups;
    }
  }

  return null;
}

function isPrivateEquityRelated(value) {
  return /\b(private equity|portfolio company|sponsor-backed|sponsor backed|backed by|investment firm|growth equity|PE firm|middle market|themiddlemarket\.com)\b/i.test(
    value
  );
}

function extractDealSize(value) {
  const match =
    value.match(/\$\s*([0-9]+(?:\.[0-9]+)?)\s*(billion|bn|million|mm|m)\b/i) ??
    value.match(/\bUSD\s*([0-9]+(?:\.[0-9]+)?)\s*(billion|bn|million|mm|m)\b/i);

  if (!match) {
    return null;
  }

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) {
    return null;
  }

  return /billion|bn/i.test(match[2]) ? amount * 1_000_000_000 : amount * 1_000_000;
}

function normalizeSector(sourceSector, evidence) {
  const explicit = firstText(sourceSector);
  if (explicit && explicit.length <= 60 && !/latest news|article|business/i.test(explicit)) {
    return explicit;
  }

  for (const [sector, pattern] of sectorRules) {
    if (pattern.test(evidence)) {
      return sector;
    }
  }

  return null;
}

function dedupeDeals(deals) {
  const seen = new Set();
  const unique = [];

  for (const deal of deals) {
    const key = `${deal.source_url}::${deal.target_company}`.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(deal);
  }

  return unique.sort((a, b) => b.published_date.localeCompare(a.published_date));
}

function buildSql(deals) {
  const rows = deals.map(
    (deal) =>
      `(${[
        sqlString(deal.id),
        sqlString(deal.published_date),
        sqlString(deal.buyer),
        sqlString(deal.target_company),
        deal.deal_size === null ? "NULL" : String(deal.deal_size),
        deal.sector === null ? "NULL" : sqlString(deal.sector),
        sqlString(deal.source_url),
        sqlString(deal.created_at)
      ].join(", ")})`
  );

  if (rows.length === 0) {
    return "-- No high-confidence PE deals extracted.\n";
  }

  return `INSERT OR IGNORE INTO pe_deals
  (id, published_date, buyer, target_company, deal_size, sector, source_url, created_at)
VALUES
${rows.join(",\n")};
`;
}

function dealId(sourceUrl) {
  return `pe_deal_${createHash("sha256").update(sourceUrl).digest("hex").slice(0, 32)}`;
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function normalizeEntity(value) {
  return cleanText(value)
    .replace(/\s+\|\s+.*$/g, "")
    .replace(/^[A-Z][a-z]+-based\s+/g, "")
    .replace(/^(?:a\s+)?majority\s+stake\s+in\s+/i, "")
    .replace(/\s+\(.+?\)\s*$/g, "")
    .replace(/,\s+.*$/g, "")
    .replace(/\s+\bin\s+a?\s*\$.*$/i, "")
    .replace(/\s+\bfor\s+\$.*$/i, "")
    .replace(/\s+\bfrom\s+.+$/i, "")
    .replace(/\s+\bto\s+(?:launch|create|form|build)\s+.+$/i, "")
    .replace(/\s+(?:LLC|Inc\.?|Ltd\.?|Limited|Corp\.?|Corporation|Company)\s*$/i, (suffix) =>
      suffix.trim()
    )
    .replace(/\b(?:today|recently|has|have|announced|announces|said|says)\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isBadEntity(value) {
  return (
    value.length < 2 ||
    value.length > 120 ||
    /^(private equity firm|private equity|company|companies|firm|business|based|two companies)\b/i.test(
      value
    ) ||
    /\b(news release|correction|shareholders|registration statement|mou|memorandum|etf|fund shares|moving average|ipo|spac)\b/i.test(
      value
    )
  );
}

function normalizeTitle(value) {
  return cleanText(value)
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\s+-\s+/g, " - ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanText(value) {
  return decodeHtml(String(value ?? ""))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(value) {
  return String(value ?? "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function firstSentence(value) {
  return cleanText(value).split(/(?<=[.!?])\s+/)[0] ?? "";
}

function firstText(value) {
  if (Array.isArray(value)) {
    return cleanText(value[0] ?? "");
  }
  return typeof value === "string" ? cleanText(value) : "";
}

function splitKeywords(value) {
  if (Array.isArray(value)) {
    return value.flatMap(splitKeywords);
  }
  if (typeof value !== "string") {
    return [];
  }
  return value
    .split(/[,;|]/)
    .map(cleanText)
    .filter(Boolean);
}

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function meta(html, attrName, attrValue) {
  const pattern = new RegExp(
    `<meta\\b(?=[^>]*\\b${attrName}=["']${escapeRegExp(attrValue)}["'])(?=[^>]*\\bcontent=["']([^"']*)["'])[^>]*>`,
    "i"
  );
  return decodeHtml(html.match(pattern)?.[1] ?? "");
}

function linkHref(html, rel) {
  const pattern = new RegExp(
    `<link\\b(?=[^>]*\\brel=["']${escapeRegExp(rel)}["'])(?=[^>]*\\bhref=["']([^"']*)["'])[^>]*>`,
    "i"
  );
  return decodeHtml(html.match(pattern)?.[1] ?? "");
}

function tagText(html, tag) {
  const pattern = new RegExp(`<${escapeRegExp(tag)}[^>]*>([\\s\\S]*?)<\\/${escapeRegExp(tag)}>`, "i");
  return decodeHtml(html.match(pattern)?.[1] ?? "");
}

function normalizeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_)/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function hostnameOf(rawUrl) {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function gdeltSeenDate(value) {
  const text = String(value ?? "");
  const match = text.match(/^(\d{4})(\d{2})(\d{2})T?(\d{2})?(\d{2})?(\d{2})?/);
  if (!match) {
    return new Date().toISOString();
  }

  return new Date(
    Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4] ?? "0"),
      Number(match[5] ?? "0"),
      Number(match[6] ?? "0")
    )
  ).toISOString();
}

function normalizeDate(value) {
  if (!value) {
    return null;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
