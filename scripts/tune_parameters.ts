import { readFile } from "node:fs/promises";
import { basename } from "node:path";

interface TickRow {
  timestamp: number;
  mid: number;
  size: number;
  isBuy: boolean;
}

interface SimulationResult {
  gamma: number;
  alpha: number;
  trades: number;
  sharpe: number;
  maxDrawdownPct: number;
  totalReturnPct: number;
  finalEquity: number;
}

interface Args {
  csv: string;
  gamma: number[];
  alpha: number[];
  initialEquity: number;
  bucketVolume: number;
  window: number;
  json: boolean;
}

const DEFAULT_GAMMA = [0.001, 0.005, 0.01, 0.02, 0.05];
const DEFAULT_ALPHA = [0, 0.1, 0.3, 0.5, 0.7];

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const ticks = await loadTicks(args.csv);
  if (ticks.length < 100) {
    throw new Error(`CSV contains ${ticks.length} usable ticks; provide at least 100 for walk-forward analysis.`);
  }

  const results: SimulationResult[] = [];
  for (const gamma of args.gamma) {
    for (const alpha of args.alpha) {
      results.push(simulate(ticks, {
        gamma,
        alpha,
        initialEquity: args.initialEquity,
        bucketVolume: args.bucketVolume,
        window: args.window
      }));
    }
  }

  results.sort((left, right) => right.sharpe - left.sharpe || left.maxDrawdownPct - right.maxDrawdownPct);

  if (args.json) {
    console.log(JSON.stringify({
      source: basename(args.csv),
      rows: ticks.length,
      assumptions: assumptions(args),
      results
    }, null, 2));
    return;
  }

  console.log(`Sovereign-Sigma walk-forward grid search`);
  console.log(`source=${basename(args.csv)} rows=${ticks.length}`);
  console.log(assumptions(args).join(" | "));
  console.table(results.map((result) => ({
    gamma: result.gamma,
    alpha: result.alpha,
    trades: result.trades,
    sharpe: round(result.sharpe, 4),
    maxDrawdownPct: round(result.maxDrawdownPct * 100, 3),
    totalReturnPct: round(result.totalReturnPct * 100, 3),
    finalEquity: round(result.finalEquity, 2)
  })));
}

function simulate(
  ticks: TickRow[],
  config: {
    gamma: number;
    alpha: number;
    initialEquity: number;
    bucketVolume: number;
    window: number;
  }
): SimulationResult {
  let equity = config.initialEquity;
  let highWaterMark = equity;
  let maxDrawdownPct = 0;
  let position = 0;
  let cash = config.initialEquity;
  let bucketBuy = 0;
  let bucketSell = 0;
  let bucketTotal = 0;
  let previousDirectionalImbalance = 0;
  let bucketPointer = 0;
  let bucketCount = 0;
  const imbalances = new Float64Array(config.window);
  const returns: number[] = [];
  let trades = 0;

  for (let index = 1; index < ticks.length; index += 1) {
    const previous = ticks[index - 1];
    const tick = ticks[index];
    const volume = Math.max(0, tick.size);

    if (tick.isBuy) {
      bucketBuy += volume;
    } else {
      bucketSell += volume;
    }
    bucketTotal += volume;

    if (bucketTotal >= config.bucketVolume) {
      const directionalImbalance = (bucketBuy - bucketSell) + config.alpha * previousDirectionalImbalance;
      previousDirectionalImbalance = directionalImbalance;
      imbalances[bucketPointer] = Math.abs(directionalImbalance);
      bucketPointer = (bucketPointer + 1) % config.window;
      bucketCount = Math.min(config.window, bucketCount + 1);
      bucketBuy = 0;
      bucketSell = 0;
      bucketTotal = 0;
    }

    const toxicity = bucketCount === 0
      ? 0
      : sumTypedArray(imbalances, bucketCount) / (bucketCount * config.bucketVolume);
    const reservationShift = position * config.gamma * toxicity * toxicity;
    const expectedMove = tick.mid - previous.mid;
    const signal = expectedMove - reservationShift;
    const targetPosition = Math.max(-1, Math.min(1, signal / Math.max(1e-9, tick.mid * 0.0001)));
    const tradeSize = targetPosition - position;

    if (Math.abs(tradeSize) > 1e-6 && toxicity < 0.85) {
      cash -= tradeSize * tick.mid;
      position += tradeSize;
      trades += 1;
    }

    const nextEquity = cash + position * tick.mid;
    const periodReturn = equity > 0 ? (nextEquity - equity) / equity : 0;
    returns.push(periodReturn);
    equity = nextEquity;
    highWaterMark = Math.max(highWaterMark, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, highWaterMark > 0 ? (highWaterMark - equity) / highWaterMark : 0);
  }

  return {
    gamma: config.gamma,
    alpha: config.alpha,
    trades,
    sharpe: annualizedSharpe(returns),
    maxDrawdownPct,
    totalReturnPct: config.initialEquity > 0 ? (equity - config.initialEquity) / config.initialEquity : 0,
    finalEquity: equity
  };
}

async function loadTicks(path: string): Promise<TickRow[]> {
  const text = await readFile(path, "utf8");
  const rows = parseCsv(text);
  if (rows.length === 0) {
    return [];
  }

  const headers = rows[0].map((header) => header.trim().toLowerCase());
  const dataRows = rows.slice(1);
  const index = (candidates: string[]): number =>
    candidates.map((candidate) => headers.indexOf(candidate)).find((value) => value >= 0) ?? -1;
  const timestampIndex = index(["timestamp", "time", "ts", "exchange_timestamp"]);
  const midIndex = index(["mid", "mid_price", "price", "px"]);
  const bidIndex = index(["bid", "best_bid"]);
  const askIndex = index(["ask", "best_ask"]);
  const sizeIndex = index(["size", "sz", "quantity", "qty", "volume"]);
  const sideIndex = index(["isbuy", "is_buy", "side", "aggressor_side"]);

  if (timestampIndex < 0 || (midIndex < 0 && (bidIndex < 0 || askIndex < 0)) || sizeIndex < 0 || sideIndex < 0) {
    throw new Error(
      "CSV must include timestamp/time, size/sz, side/isBuy, and either mid/price or bid+ask columns."
    );
  }

  return dataRows.flatMap((row): TickRow[] => {
    const timestamp = parseTimestamp(row[timestampIndex]);
    const mid = midIndex >= 0
      ? Number(row[midIndex])
      : (Number(row[bidIndex]) + Number(row[askIndex])) / 2;
    const size = Number(row[sizeIndex]);
    const isBuy = parseSide(row[sideIndex]);

    if (!Number.isFinite(timestamp) || !Number.isFinite(mid) || mid <= 0 || !Number.isFinite(size) || size <= 0 || isBuy === null) {
      return [];
    }

    return [{ timestamp, mid, size, isBuy }];
  }).sort((left, right) => left.timestamp - right.timestamp);
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string | boolean>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      continue;
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      values.set(key, true);
      continue;
    }
    values.set(key, next);
    index += 1;
  }

  const csv = stringValue(values.get("csv"));
  if (!csv) {
    throw new Error("Usage: npm run tune:parameters -- --csv ./hyperliquid_ticks.csv [--gamma 0.001,0.01] [--alpha 0.1,0.3] [--json]");
  }

  return {
    csv,
    gamma: numberList(values.get("gamma"), DEFAULT_GAMMA),
    alpha: numberList(values.get("alpha"), DEFAULT_ALPHA),
    initialEquity: positiveNumber(values.get("initial-equity"), 10_000),
    bucketVolume: positiveNumber(values.get("bucket-volume"), 10),
    window: Math.max(5, Math.round(positiveNumber(values.get("window"), 50))),
    json: values.get("json") === true
  };
}

function assumptions(args: Args): string[] {
  return [
    `initialEquity=${args.initialEquity}`,
    `bucketVolume=${args.bucketVolume}`,
    `window=${args.window}`,
    "model=inventory-skew proxy; use as parameter frontier, not live PnL guarantee"
  ];
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (inQuotes) {
      if (char === "\"" && next === "\"") {
        field += "\"";
        index += 1;
      } else if (char === "\"") {
        inQuotes = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === "\"") {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }

  row.push(field);
  rows.push(row);
  return rows.filter((items) => items.some((item) => item.trim().length > 0));
}

function parseTimestamp(value: string): number {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric > 10_000_000_000 ? numeric : numeric * 1000;
  }
  return Date.parse(value);
}

function parseSide(value: string): boolean | null {
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "buy", "b", "bid"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "sell", "s", "ask"].includes(normalized)) {
    return false;
  }
  return null;
}

function annualizedSharpe(returns: number[]): number {
  if (returns.length < 2) {
    return 0;
  }
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  const std = Math.sqrt(variance);
  return std > 0 ? (mean / std) * Math.sqrt(365 * 24 * 60) : 0;
}

function sumTypedArray(values: Float64Array, count: number): number {
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    total += values[index] ?? 0;
  }
  return total;
}

function numberList(value: string | boolean | undefined, fallback: number[]): number[] {
  const text = stringValue(value);
  if (!text) {
    return fallback;
  }
  const parsed = text.split(",").map((item) => Number(item.trim())).filter((item) => Number.isFinite(item) && item >= 0);
  return parsed.length > 0 ? parsed : fallback;
}

function positiveNumber(value: string | boolean | undefined, fallback: number): number {
  const parsed = Number(stringValue(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function stringValue(value: string | boolean | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function round(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Unknown tuning harness error");
  process.exitCode = 1;
});
