import type { JsonRecord } from "../types";

export type CongressOptionType = "CALL" | "PUT";
export type CongressOptionExposure =
  | "BULLISH"
  | "BEARISH"
  | "INCOME_OR_CLOSING"
  | "HEDGE_OR_PROTECTION";

export interface CongressOptionDecode extends JsonRecord {
  isOption: true;
  underlying: string;
  underlyingLabel: string;
  optionType: CongressOptionType;
  strike: number;
  strikeLabel: string;
  expirationDate: string;
  expirationLabel: string;
  expirationStatus: "FUTURE" | "EXPIRED";
  tenorDays: number | null;
  isLeap: boolean;
  exposure: CongressOptionExposure;
  intensity: "HIGH" | "MEDIUM" | "LOW";
  shortLabel: string;
  plainEnglish: string;
  caveat: string;
}

interface OptionDecodeInput {
  symbol: string | null;
  assetName: string | null;
  rawText: string | null;
  transactionType: string;
  transactionDate: string | null;
}

interface ParsedOptionContract {
  underlying: string;
  optionType: CongressOptionType;
  strike: number;
  expirationDate: string;
}

const OPTION_DATE_PATTERN = String.raw`\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}`;
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December"
];

export function decodeCongressOptionTrade(input: OptionDecodeInput): CongressOptionDecode | null {
  const text = compactText(`${input.assetName ?? ""} ${input.rawText ?? ""}`);
  if (!text || !hasOptionSignal(text)) {
    return null;
  }

  if (isCallableDebtText(text)) {
    return null;
  }

  const parsed = parseOccStyleContract(text) ?? parseReadableContract(text, input.symbol);
  if (!parsed) {
    return null;
  }

  const transactionAction = normalizeTransactionAction(input.transactionType);
  const exposure = optionExposure(parsed.optionType, transactionAction);
  const transactionDate = parseIsoDate(input.transactionDate) ?? new Date();
  const expirationDate = parseIsoDate(parsed.expirationDate);
  const tenorDays = expirationDate ? daysBetween(transactionDate, expirationDate) : null;
  const isLeap = typeof tenorDays === "number" && tenorDays >= 365;
  const expirationStatus =
    expirationDate && expirationDate.getTime() < startOfUtcDay(new Date()).getTime()
      ? "EXPIRED"
      : "FUTURE";
  const intensity = isLeap && transactionAction === "PURCHASE" ? "HIGH" : "MEDIUM";
  const underlyingLabel = readableUnderlyingLabel(input.assetName, parsed.underlying);
  const strikeLabel = formatStrike(parsed.strike);
  const expirationLabel = formatIsoDate(parsed.expirationDate);

  return {
    isOption: true,
    underlying: parsed.underlying,
    underlyingLabel,
    optionType: parsed.optionType,
    strike: parsed.strike,
    strikeLabel,
    expirationDate: parsed.expirationDate,
    expirationLabel,
    expirationStatus,
    tenorDays,
    isLeap,
    exposure,
    intensity,
    shortLabel: `${parsed.underlying} ${expirationLabel} ${strikeLabel}${parsed.optionType[0]}`,
    plainEnglish: optionPlainEnglish({
      action: transactionAction,
      exposure,
      expirationLabel,
      intensity,
      isLeap,
      optionType: parsed.optionType,
      strikeLabel,
      underlyingLabel
    }),
    caveat:
      "Premium, contract count, and whether the trade opened or closed exposure are not always disclosed in PTR text."
  };
}

function isCallableDebtText(text: string): boolean {
  const upper = text.toUpperCase();
  const hasDebtLanguage = /\b(DUE|BOND|BONDS|NOTE|NOTES|MUNI|MUNICIPAL|GO|REV|REVENUE)\b/.test(
    upper
  );
  const hasExplicitOptionLanguage =
    /\b(OPTION|OPTIONS|LEAPS?|PUT|PUTS)\b/.test(upper) ||
    /\$?\d+(?:\.\d+)?\s*[CP]\b/.test(upper) ||
    /\b[A-Z]{1,6}\s*\d{6}[CP]\d{8}\b/.test(upper);

  return hasDebtLanguage && /\bCALL\b/.test(upper) && !hasExplicitOptionLanguage;
}

function hasOptionSignal(text: string): boolean {
  return (
    /\b(CALL|CALLS|PUT|PUTS|OPTION|OPTIONS|LEAPS?)\b/i.test(text) ||
    new RegExp(String.raw`\b${OPTION_DATE_PATTERN}\b.{0,80}?\$?\d+(?:\.\d+)?\s*[CP]\b`, "i").test(
      text
    ) ||
    /\b[A-Z]{1,6}\s*\d{6}[CP]\d{8}\b/.test(text)
  );
}

function parseOccStyleContract(text: string): ParsedOptionContract | null {
  const match = /\b(?<root>[A-Z]{1,6})\s*(?<yy>\d{2})(?<mm>\d{2})(?<dd>\d{2})(?<kind>[CP])(?<strike>\d{8})\b/.exec(
    text.toUpperCase()
  );
  if (!match?.groups) {
    return null;
  }

  const year = 2000 + Number(match.groups.yy);
  const month = Number(match.groups.mm);
  const day = Number(match.groups.dd);
  const expirationDate = isoDate(year, month, day);
  const strike = Number(match.groups.strike) / 1000;

  if (!expirationDate || !Number.isFinite(strike) || strike <= 0) {
    return null;
  }

  return {
    underlying: normalizeUnderlying(match.groups.root),
    optionType: match.groups.kind === "C" ? "CALL" : "PUT",
    strike,
    expirationDate
  };
}

function parseReadableContract(text: string, symbol: string | null): ParsedOptionContract | null {
  const patterns = [
    new RegExp(
      String.raw`\b(?<root>[A-Z][A-Z0-9.-]{0,7})\s+(?<expiry>${OPTION_DATE_PATTERN})\s+\$?(?<strike>\d{1,6}(?:\.\d+)?)\s*(?<kind>CALL|PUT|C|P)\b`,
      "i"
    ),
    new RegExp(
      String.raw`\b(?<root>[A-Z][A-Z0-9.-]{0,7})\s+\$?(?<strike>\d{1,6}(?:\.\d+)?)\s*(?<kind>CALL|PUT|C|P)\s+(?<expiry>${OPTION_DATE_PATTERN})\b`,
      "i"
    ),
    new RegExp(
      String.raw`\b(?<root>[A-Z][A-Z0-9.-]{0,7})\s+(?<kind>CALL|PUT)S?\s+\$?(?<strike>\d{1,6}(?:\.\d+)?)\s+(?<expiry>${OPTION_DATE_PATTERN})\b`,
      "i"
    ),
    new RegExp(
      String.raw`\b(?<expiry>${OPTION_DATE_PATTERN})\b.{0,80}?\$?(?<strike>\d{1,6}(?:\.\d+)?)\s*(?<kind>CALL|PUT|C|P)\b`,
      "i"
    ),
    new RegExp(
      String.raw`\b(?<kind>CALL|PUT)S?\b.{0,80}?\$?(?<strike>\d{1,6}(?:\.\d+)?).{0,80}?\b(?<expiry>${OPTION_DATE_PATTERN})\b`,
      "i"
    )
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match?.groups) {
      continue;
    }

    const root =
      normalizeUnderlying(match.groups.root) ||
      normalizeUnderlying(symbol) ||
      extractParentheticalTicker(text);
    const expirationDate = parseOptionDateToken(match.groups.expiry);
    const strike = Number(match.groups.strike);
    const optionType = normalizeOptionType(match.groups.kind);

    if (root && expirationDate && Number.isFinite(strike) && strike > 0 && optionType) {
      return {
        underlying: root,
        optionType,
        strike,
        expirationDate
      };
    }
  }

  return null;
}

function parseOptionDateToken(value: string): string | null {
  const match = /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/.exec(value.trim());
  if (!match) {
    return null;
  }

  const month = Number(match[1]);
  const day = Number(match[2]);
  const rawYear = Number(match[3]);
  const year = rawYear < 100 ? (rawYear >= 70 ? 1900 + rawYear : 2000 + rawYear) : rawYear;

  return isoDate(year, month, day);
}

function isoDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return date.toISOString().slice(0, 10);
}

function normalizeOptionType(value: string | undefined): CongressOptionType | null {
  const normalized = value?.trim().toUpperCase();
  if (normalized === "C" || normalized === "CALL" || normalized === "CALLS") {
    return "CALL";
  }
  if (normalized === "P" || normalized === "PUT" || normalized === "PUTS") {
    return "PUT";
  }
  return null;
}

function optionExposure(
  optionType: CongressOptionType,
  action: "PURCHASE" | "SALE" | "OTHER"
): CongressOptionExposure {
  if (action === "PURCHASE" && optionType === "CALL") {
    return "BULLISH";
  }
  if (action === "PURCHASE" && optionType === "PUT") {
    return "HEDGE_OR_PROTECTION";
  }
  if (action === "SALE" && optionType === "PUT") {
    return "BULLISH";
  }
  if (action === "SALE" && optionType === "CALL") {
    return "INCOME_OR_CLOSING";
  }
  return optionType === "CALL" ? "BULLISH" : "BEARISH";
}

function optionPlainEnglish(input: {
  action: "PURCHASE" | "SALE" | "OTHER";
  exposure: CongressOptionExposure;
  expirationLabel: string;
  intensity: "HIGH" | "MEDIUM" | "LOW";
  isLeap: boolean;
  optionType: CongressOptionType;
  strikeLabel: string;
  underlyingLabel: string;
}): string {
  const term = input.isLeap ? "long-dated " : "";
  const force = input.intensity === "HIGH" ? "Highly " : "";
  const target =
    input.optionType === "CALL"
      ? `stay above ${input.strikeLabel}`
      : `fall below ${input.strikeLabel}`;

  if (input.action === "PURCHASE" && input.optionType === "CALL") {
    return `${force}bullish ${term}bet that ${input.underlyingLabel} will ${target} by ${input.expirationLabel}.`;
  }

  if (input.action === "PURCHASE" && input.optionType === "PUT") {
    return `${force}bearish or protective ${term}bet that ${input.underlyingLabel} may ${target} by ${input.expirationLabel}.`;
  }

  if (input.action === "SALE" && input.optionType === "PUT") {
    return `Bullish or income-seeking ${term}put sale; the filer is exposed if ${input.underlyingLabel} falls below ${input.strikeLabel} by ${input.expirationLabel}.`;
  }

  if (input.action === "SALE" && input.optionType === "CALL") {
    return `Income, covered-call, or closing ${term}call sale; upside above ${input.strikeLabel} by ${input.expirationLabel} may be capped.`;
  }

  return `${input.optionType} option tied to ${input.underlyingLabel}, strike ${input.strikeLabel}, expiring ${input.expirationLabel}.`;
}

function normalizeTransactionAction(value: string): "PURCHASE" | "SALE" | "OTHER" {
  const normalized = value.trim().toUpperCase();
  if (["P", "BUY", "BOUGHT", "PURCHASE", "PURCHASED"].includes(normalized)) {
    return "PURCHASE";
  }
  if (["S", "SELL", "SOLD", "SALE"].includes(normalized)) {
    return "SALE";
  }
  return "OTHER";
}

function normalizeUnderlying(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toUpperCase()
    .replace(/^\$/, "")
    .replace(/[^A-Z0-9.-]/g, "")
    .slice(0, 12);
}

function extractParentheticalTicker(text: string): string {
  const match = /\(\$?([A-Z][A-Z0-9.-]{0,7})\)/.exec(text.toUpperCase());
  return normalizeUnderlying(match?.[1]);
}

function readableUnderlyingLabel(assetName: string | null, underlying: string): string {
  const cleaned = compactText(assetName ?? "")
    .replace(/\b(CALL|CALLS|PUT|PUTS|OPTION|OPTIONS|LEAPS?)\b.*$/i, "")
    .replace(new RegExp(String.raw`\b${OPTION_DATE_PATTERN}\b.*$`, "i"), "")
    .replace(/\(\$?[A-Z][A-Z0-9.-]{0,7}\)/g, "")
    .replace(/\s+-\s+Common Stock.*$/i, "")
    .replace(/\s+Common Stock.*$/i, "")
    .trim();

  if (cleaned && !/^\$?[A-Z0-9.-]{1,8}$/.test(cleaned)) {
    return cleaned;
  }

  return underlying;
}

function formatStrike(value: number): string {
  return `$${value.toLocaleString("en-US", {
    maximumFractionDigits: value % 1 === 0 ? 0 : 2,
    minimumFractionDigits: 0
  })}`;
}

function formatIsoDate(value: string): string {
  const parsed = parseIsoDate(value);
  if (!parsed) {
    return value;
  }

  return `${MONTHS[parsed.getUTCMonth()]} ${parsed.getUTCDate()}, ${parsed.getUTCFullYear()}`;
}

function parseIsoDate(value: string | null): Date | null {
  if (!value) {
    return null;
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) {
    return null;
  }

  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(date.getTime()) ? null : date;
}

function daysBetween(start: Date, end: Date): number {
  return Math.round((startOfUtcDay(end).getTime() - startOfUtcDay(start).getTime()) / 86_400_000);
}

function startOfUtcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
