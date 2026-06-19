import type { JsonRecord } from "../types";

export interface CongressCommitteeAssignmentInput {
  memberName?: string;
  chamber?: string;
  committeeCode?: string;
  committeeName?: string;
  committeeRole?: string;
  source?: string;
  sourceUpdatedAt?: string;
}

export interface CongressConflictCandidate {
  transactionId: string;
  chamber: string;
  memberName: string | null;
  symbol: string | null;
  assetName: string | null;
  transactionType: string;
}

export interface CongressConflictFlagRecord {
  flagId: string;
  transactionId: string;
  memberName: string | null;
  chamber: string;
  symbol: string | null;
  assetName: string | null;
  transactionType: string;
  sector: string;
  committeeCode: string;
  committeeName: string;
  committeeRole: string | null;
  severity: "LOW" | "MEDIUM" | "HIGH";
  reason: string;
  source: string;
}

export interface CongressConflictFlagRow {
  flag_id: string;
  transaction_id: string;
  member_name: string | null;
  chamber: string;
  symbol: string | null;
  asset_name: string | null;
  transaction_type: string;
  sector: string;
  committee_code: string;
  committee_name: string;
  committee_role: string | null;
  severity: string;
  reason: string;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface NormalizedCommitteeAssignment {
  memberKey: string;
  memberName: string;
  chamber: string;
  committeeCode: string;
  committeeName: string;
  committeeRole: string | null;
  source: string;
  sourceUpdatedAt: string | null;
}

const SYMBOL_SECTOR_RULES: Record<string, string> = {
  AAPL: "TECHNOLOGY",
  ABBV: "HEALTHCARE",
  ABT: "HEALTHCARE",
  AMGN: "HEALTHCARE",
  AMZN: "TECHNOLOGY",
  BA: "DEFENSE",
  BAC: "FINANCIALS",
  CAT: "INDUSTRIALS",
  CI: "HEALTHCARE",
  C: "FINANCIALS",
  COP: "ENERGY",
  COST: "CONSUMER",
  CRM: "TECHNOLOGY",
  CVX: "ENERGY",
  DE: "AGRICULTURE",
  DUK: "ENERGY",
  ENB: "ENERGY",
  GD: "DEFENSE",
  GILD: "HEALTHCARE",
  GOOG: "TECHNOLOGY",
  GOOGL: "TECHNOLOGY",
  GS: "FINANCIALS",
  HAL: "ENERGY",
  HII: "DEFENSE",
  HUM: "HEALTHCARE",
  JPM: "FINANCIALS",
  LHX: "DEFENSE",
  LMT: "DEFENSE",
  LLY: "HEALTHCARE",
  MA: "FINANCIALS",
  META: "TECHNOLOGY",
  MRK: "HEALTHCARE",
  MS: "FINANCIALS",
  MSFT: "TECHNOLOGY",
  NEE: "ENERGY",
  NOC: "DEFENSE",
  NVDA: "TECHNOLOGY",
  OXY: "ENERGY",
  PFE: "HEALTHCARE",
  PLTR: "DEFENSE",
  RTX: "DEFENSE",
  SLB: "ENERGY",
  SO: "ENERGY",
  T: "COMMUNICATIONS",
  UNH: "HEALTHCARE",
  V: "FINANCIALS",
  VLO: "ENERGY",
  WFC: "FINANCIALS",
  XOM: "ENERGY"
};

const ASSET_SECTOR_PATTERNS: Array<[RegExp, string]> = [
  [
    /\b(LOCKHEED|NORTHROP|RAYTHEON|RTX|GENERAL\s+DYNAMICS|BOEING|HUNTINGTON\s+INGALLS|PALANTIR)\b/i,
    "DEFENSE"
  ],
  [
    /\b(CHEVRON|EXXON|CONOCOPHILLIPS|OCCIDENTAL|ENBRIDGE|VALERO|SCHLUMBERGER|PIPELINE|OIL|GAS|ENERGY)\b/i,
    "ENERGY"
  ],
  [
    /\b(PFIZER|MERCK|ABBVIE|ELI\s+LILLY|UNITEDHEALTH|HUMANA|HOSPITAL|PHARMA|BIOTECH|HEALTH)\b/i,
    "HEALTHCARE"
  ],
  [/\b(JPMORGAN|GOLDMAN|MORGAN\s+STANLEY|BANK|VISA|MASTERCARD|FINANCIAL)\b/i, "FINANCIALS"],
  [
    /\b(MICROSOFT|APPLE|NVIDIA|ALPHABET|GOOGLE|META|AMAZON|SOFTWARE|SEMICONDUCTOR|CLOUD)\b/i,
    "TECHNOLOGY"
  ],
  [/\b(DEERE|ARCHER\s+DANIELS|FARM|AGRICULTURE|FERTILIZER)\b/i, "AGRICULTURE"],
  [/\b(AIRLINE|RAIL|RAILROAD|TRUCKING|TRANSPORT|INFRASTRUCTURE)\b/i, "TRANSPORTATION"]
];

const COMMITTEE_SECTOR_PATTERNS: Array<[RegExp, string[]]> = [
  [/\barmed\s+services\b/i, ["DEFENSE"]],
  [/\bintelligence\b/i, ["DEFENSE", "TECHNOLOGY"]],
  [/\bhomeland\s+security\b/i, ["DEFENSE", "TECHNOLOGY"]],
  [/\benergy\b|\bnatural\s+resources\b/i, ["ENERGY"]],
  [/\benergy\s+and\s+commerce\b/i, ["ENERGY", "HEALTHCARE", "TECHNOLOGY", "COMMUNICATIONS"]],
  [/\bhealth\b|\bhelp\b|\baging\b/i, ["HEALTHCARE"]],
  [
    /\bfinancial\s+services\b|\bbanking\b|\bfinance\b|\bways\s+and\s+means\b|\btaxation\b/i,
    ["FINANCIALS"]
  ],
  [/\bcommerce\b|\bscience\b|\btechnology\b/i, ["TECHNOLOGY", "COMMUNICATIONS", "TRANSPORTATION"]],
  [/\bagriculture\b/i, ["AGRICULTURE"]],
  [/\btransportation\b|\binfrastructure\b/i, ["TRANSPORTATION", "INDUSTRIALS"]],
  [/\bjudiciary\b|\bantitrust\b/i, ["TECHNOLOGY", "COMMUNICATIONS"]]
];

export function normalizeCommitteeAssignment(
  input: CongressCommitteeAssignmentInput
): NormalizedCommitteeAssignment | null {
  const memberName = cleanText(input.memberName);
  const committeeName = cleanText(input.committeeName);
  const committeeCode = cleanText(input.committeeCode)?.toUpperCase();

  if (!memberName || !committeeName || !committeeCode) {
    return null;
  }

  return {
    memberKey: normalizeCongressMemberKey(memberName),
    memberName,
    chamber: normalizeChamber(input.chamber),
    committeeCode,
    committeeName,
    committeeRole: cleanText(input.committeeRole),
    source: cleanText(input.source) ?? "unitedstates/congress-legislators",
    sourceUpdatedAt: cleanText(input.sourceUpdatedAt)
  };
}

export function evaluateCongressConflicts(
  assignmentsByMember: Map<string, NormalizedCommitteeAssignment[]>,
  candidate: CongressConflictCandidate
): CongressConflictFlagRecord[] {
  const memberKey = normalizeCongressMemberKey(candidate.memberName);
  const sector = resolveSecuritySector(candidate.symbol, candidate.assetName);

  if (!memberKey || !sector) {
    return [];
  }

  const assignments = assignmentsByMember.get(memberKey) ?? [];
  const flags: CongressConflictFlagRecord[] = [];
  const seen = new Set<string>();

  for (const assignment of assignments) {
    const committeeSectors = resolveCommitteeSectors(assignment.committeeName);

    if (!committeeSectors.includes(sector)) {
      continue;
    }

    const key = `${assignment.committeeCode}:${sector}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    flags.push({
      flagId: `conflict_${candidate.transactionId}_${assignment.committeeCode}_${sector}`.replace(
        /[^A-Za-z0-9_]/g,
        "_"
      ),
      transactionId: candidate.transactionId,
      memberName: candidate.memberName,
      chamber: normalizeChamber(candidate.chamber),
      symbol: candidate.symbol,
      assetName: candidate.assetName,
      transactionType: candidate.transactionType,
      sector,
      committeeCode: assignment.committeeCode,
      committeeName: assignment.committeeName,
      committeeRole: assignment.committeeRole,
      severity: conflictSeverity(candidate.transactionType, assignment.committeeName, sector),
      reason: conflictReason(candidate, assignment, sector),
      source: assignment.source
    });
  }

  return flags;
}

export function summarizeConflictFlags(flags: CongressConflictFlagRow[]): JsonRecord[] {
  return flags.map((flag) => ({
    flagId: flag.flag_id,
    severity: flag.severity,
    sector: flag.sector,
    committeeCode: flag.committee_code,
    committeeName: flag.committee_name,
    committeeRole: flag.committee_role,
    reason: flag.reason,
    source: flag.source,
    createdAt: flag.created_at
  }));
}

export function resolveSecuritySector(
  symbol: string | null,
  assetName: string | null
): string | null {
  const normalizedSymbol = cleanText(symbol)?.toUpperCase();
  if (normalizedSymbol && SYMBOL_SECTOR_RULES[normalizedSymbol]) {
    return SYMBOL_SECTOR_RULES[normalizedSymbol];
  }

  const text = cleanText(assetName);
  if (!text) {
    return null;
  }

  for (const [pattern, sector] of ASSET_SECTOR_PATTERNS) {
    if (pattern.test(text)) {
      return sector;
    }
  }

  return null;
}

export function normalizeCongressMemberKey(value: string | null | undefined): string {
  const cleaned = cleanText(value)
    ?.replace(/\b(Hon|Honorable|Sen|Senator|Rep|Representative|Mr|Mrs|Ms|Dr)\.?\b/gi, " ")
    .replace(/\b(Jr|Sr|II|III|IV)\.?\b/gi, " ")
    .replace(/\.+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) {
    return "";
  }

  const commaParts = cleaned
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const ordered =
    commaParts.length >= 2 ? `${commaParts.slice(1).join(" ")} ${commaParts[0]}` : cleaned;

  return ordered
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function resolveCommitteeSectors(committeeName: string): string[] {
  const sectors = new Set<string>();

  for (const [pattern, mappedSectors] of COMMITTEE_SECTOR_PATTERNS) {
    if (pattern.test(committeeName)) {
      for (const sector of mappedSectors) {
        sectors.add(sector);
      }
    }
  }

  return [...sectors];
}

function conflictSeverity(
  transactionType: string,
  committeeName: string,
  sector: string
): "LOW" | "MEDIUM" | "HIGH" {
  const isPurchase = transactionType.toUpperCase() === "PURCHASE";
  const directHighSignal =
    (sector === "DEFENSE" && /\barmed\s+services\b/i.test(committeeName)) ||
    (sector === "ENERGY" && /\benergy\b|\bnatural\s+resources\b/i.test(committeeName)) ||
    (sector === "HEALTHCARE" && /\bhealth\b|\benergy\s+and\s+commerce\b/i.test(committeeName)) ||
    (sector === "FINANCIALS" &&
      /\bfinancial\s+services\b|\bbanking\b|\bfinance\b/i.test(committeeName));

  if (isPurchase && directHighSignal) {
    return "HIGH";
  }

  return isPurchase ? "MEDIUM" : "LOW";
}

function conflictReason(
  candidate: CongressConflictCandidate,
  assignment: NormalizedCommitteeAssignment,
  sector: string
): string {
  const instrument = candidate.symbol || candidate.assetName || "the disclosed asset";
  return `${assignment.memberName} sits on ${assignment.committeeName}, which overlaps ${sector} exposure for ${instrument}.`;
}

function normalizeChamber(value: unknown): string {
  if (typeof value !== "string") {
    return "unknown";
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "house" || normalized === "senate" || normalized === "joint"
    ? normalized
    : "unknown";
}

function cleanText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
