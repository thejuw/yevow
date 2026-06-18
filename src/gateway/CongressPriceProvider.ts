import type { JsonRecord } from "../types";

const YAHOO_CHART_BASE = "https://query1.finance.yahoo.com/v8/finance/chart";
const STOOQ_DAILY_BASE = "https://stooq.com/q/d/l/";
const DAY_MS = 24 * 60 * 60 * 1000;

interface YahooChartResponse {
  chart?: {
    result?: Array<{
      meta?: {
        currency?: string;
        regularMarketPrice?: number;
        regularMarketTime?: number;
        symbol?: string;
      };
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          close?: Array<number | null>;
        }>;
      };
    }>;
    error?: {
      code?: string;
      description?: string;
    } | null;
  };
}

export interface CongressPriceMark {
  symbol: string;
  provider: "YAHOO_CHART" | "STOOQ_DAILY";
  currentPrice: number;
  currentPriceAsOf: string;
  transactionPrice: number | null;
  transactionPriceAsOf: string | null;
  raw: JsonRecord;
}

export function normalizeTickerSymbol(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const cleaned = value
    .trim()
    .replace(/^\$/, "")
    .replace(/\s+/g, "")
    .toUpperCase();

  if (!/^[A-Z0-9.\-]{1,16}$/.test(cleaned)) {
    return null;
  }

  return cleaned;
}

export async function fetchCongressPriceMark(
  rawSymbol: string,
  transactionDate: string | null = null
): Promise<CongressPriceMark> {
  const symbol = normalizeTickerSymbol(rawSymbol);

  if (!symbol) {
    throw new Error("Invalid ticker symbol");
  }

  try {
    return await fetchYahooPriceMark(symbol, transactionDate);
  } catch (yahooError) {
    const fallback = await fetchStooqPriceMark(symbol, transactionDate);
    return {
      ...fallback,
      raw: {
        ...fallback.raw,
        yahooFallbackReason: errorMessage(yahooError)
      }
    };
  }
}

async function fetchYahooPriceMark(
  symbol: string,
  transactionDate: string | null
): Promise<CongressPriceMark> {
  const yahooSymbol = symbol.replace(".", "-");
  const latestUrl = `${YAHOO_CHART_BASE}/${encodeURIComponent(yahooSymbol)}?range=5d&interval=1d`;
  const latest = await fetchYahooChart(latestUrl);
  const latestResult = firstYahooResult(latest);
  const currentPrice = latestResult.meta?.regularMarketPrice ?? lastFiniteClose(latestResult);

  if (!isPositiveFinite(currentPrice)) {
    throw new Error(`Yahoo returned no current price for ${symbol}`);
  }

  const marketTime = latestResult.meta?.regularMarketTime;
  const currentPriceAsOf = marketTime
    ? new Date(marketTime * 1000).toISOString()
    : new Date().toISOString();
  const historical = transactionDate
    ? await fetchYahooHistoricalPrice(yahooSymbol, transactionDate)
    : { price: null, asOf: null };

  return {
    symbol,
    provider: "YAHOO_CHART",
    currentPrice,
    currentPriceAsOf,
    transactionPrice: historical.price,
    transactionPriceAsOf: historical.asOf,
    raw: {
      yahooSymbol,
      currency: latestResult.meta?.currency ?? null,
      currentEndpoint: "chart",
      historicalEndpoint: transactionDate ? "chart-period" : null
    }
  };
}

async function fetchYahooHistoricalPrice(
  yahooSymbol: string,
  transactionDate: string
): Promise<{ price: number | null; asOf: string | null }> {
  const parsed = parseDate(transactionDate);

  if (!parsed) {
    return { price: null, asOf: null };
  }

  const period1 = Math.floor((parsed.getTime() - 4 * DAY_MS) / 1000);
  const period2 = Math.floor((parsed.getTime() + 10 * DAY_MS) / 1000);
  const url = `${YAHOO_CHART_BASE}/${encodeURIComponent(
    yahooSymbol
  )}?period1=${period1}&period2=${period2}&interval=1d`;
  const chart = await fetchYahooChart(url);
  const result = firstYahooResult(chart);
  const timestamps = result.timestamp ?? [];
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  const targetStart = Date.UTC(
    parsed.getUTCFullYear(),
    parsed.getUTCMonth(),
    parsed.getUTCDate()
  );

  for (let index = 0; index < timestamps.length; index += 1) {
    const close = closes[index];
    const timestampMs = (timestamps[index] ?? 0) * 1000;

    if (timestampMs >= targetStart && isPositiveFinite(close)) {
      return { price: close, asOf: new Date(timestampMs).toISOString() };
    }
  }

  return { price: null, asOf: null };
}

async function fetchYahooChart(url: string): Promise<YahooChartResponse> {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "Sovereign-Sigma-Congress-Tracker/1.0"
    }
  });

  if (!response.ok) {
    throw new Error(`Yahoo chart request failed with HTTP ${response.status}`);
  }

  return (await response.json()) as YahooChartResponse;
}

function firstYahooResult(response: YahooChartResponse): NonNullable<
  NonNullable<YahooChartResponse["chart"]>["result"]
>[number] {
  const error = response.chart?.error;

  if (error) {
    throw new Error(error.description ?? error.code ?? "Yahoo chart returned an error");
  }

  const result = response.chart?.result?.[0];

  if (!result) {
    throw new Error("Yahoo chart returned no result");
  }

  return result;
}

async function fetchStooqPriceMark(
  symbol: string,
  transactionDate: string | null
): Promise<CongressPriceMark> {
  const stooqSymbol = `${symbol.toLowerCase().replace(".", "-")}.us`;
  const url = `${STOOQ_DAILY_BASE}?s=${encodeURIComponent(stooqSymbol)}&i=d`;
  const response = await fetch(url, {
    headers: {
      accept: "text/csv",
      "user-agent": "Sovereign-Sigma-Congress-Tracker/1.0"
    }
  });

  if (!response.ok) {
    throw new Error(`Stooq daily request failed with HTTP ${response.status}`);
  }

  const rows = parseCsv(await response.text());
  const latest = lastPriceRow(rows);

  if (!latest) {
    throw new Error(`Stooq returned no current price for ${symbol}`);
  }

  const historical = transactionDate ? closestRowOnOrAfter(rows, transactionDate) : null;

  return {
    symbol,
    provider: "STOOQ_DAILY",
    currentPrice: latest.close,
    currentPriceAsOf: new Date(`${latest.date}T21:00:00.000Z`).toISOString(),
    transactionPrice: historical?.close ?? null,
    transactionPriceAsOf: historical
      ? new Date(`${historical.date}T21:00:00.000Z`).toISOString()
      : null,
    raw: {
      stooqSymbol,
      endpoint: "daily-csv"
    }
  };
}

function parseCsv(text: string): Array<Record<string, string>> {
  const lines = text
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);

  if (lines.length < 2) {
    return [];
  }

  const headers = lines[0].split(",").map((header) => header.trim().toLowerCase());
  const rows: Array<Record<string, string>> = [];

  for (let index = 1; index < lines.length; index += 1) {
    const cells = lines[index].split(",");
    const row: Record<string, string> = {};

    for (let column = 0; column < headers.length; column += 1) {
      row[headers[column]] = cells[column]?.trim() ?? "";
    }

    rows.push(row);
  }

  return rows;
}

function lastPriceRow(rows: Array<Record<string, string>>): { date: string; close: number } | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    const close = Number(row.close);

    if (row.date && isPositiveFinite(close)) {
      return { date: row.date, close };
    }
  }

  return null;
}

function closestRowOnOrAfter(
  rows: Array<Record<string, string>>,
  transactionDate: string
): { date: string; close: number } | null {
  const target = parseDate(transactionDate);

  if (!target) {
    return null;
  }

  const targetTime = Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate());

  for (const row of rows) {
    const close = Number(row.close);
    const rowDate = parseDate(row.date);

    if (rowDate && rowDate.getTime() >= targetTime && isPositiveFinite(close)) {
      return { date: row.date, close };
    }
  }

  return null;
}

function lastFiniteClose(
  result: NonNullable<NonNullable<YahooChartResponse["chart"]>["result"]>[number]
): number | null {
  const closes = result.indicators?.quote?.[0]?.close ?? [];

  for (let index = closes.length - 1; index >= 0; index -= 1) {
    const close = closes[index];

    if (isPositiveFinite(close)) {
      return close;
    }
  }

  return null;
}

function parseDate(value: string): Date | null {
  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
