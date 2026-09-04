import { GAME_MANIFEST, type ExportSource, type GameCode, type Session } from "./manifest";

export interface ParsedDraw {
  readonly game: GameCode;
  readonly drawDate: string;
  readonly session: Session;
  readonly orderedNumbers: readonly number[];
  readonly canonicalNumbers: readonly number[];
  readonly bonusNumbers: readonly number[];
  readonly metadata: Readonly<Record<string, number | string>>;
  readonly sourceLine: number;
  readonly rawRecord: string;
  readonly fingerprint: string;
}

export interface ParseIssue {
  readonly sourceLine: number;
  readonly rawRecord: string;
  readonly reason: string;
}

export interface ParseResult {
  readonly draws: readonly ParsedDraw[];
  readonly issues: readonly ParseIssue[];
  readonly totalRows: number;
  readonly observedWidths: Readonly<Record<string, number>>;
}

export class RowError extends Error {
  override readonly name = "RowError";
}

export class SchemaMismatchError extends Error {
  override readonly name = "SchemaMismatchError";

  constructor(
    message: string,
    readonly issues: readonly ParseIssue[] = []
  ) {
    super(message);
  }
}

function csvLine(raw: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  let closedQuote = false;

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw.charAt(index);
    if (quoted) {
      if (character === '"') {
        if (raw[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (character === ",") {
      fields.push(field);
      field = "";
      closedQuote = false;
    } else if (character === '"') {
      if (field.length > 0 || closedQuote) throw new RowError("invalid CSV quote placement");
      quoted = true;
    } else {
      if (closedQuote && character.trim() !== "") {
        throw new RowError("characters follow a closed CSV quote");
      }
      if (!closedQuote) field += character;
    }
  }

  if (quoted) throw new RowError("unterminated CSV quote");
  fields.push(field);
  while (fields.length > 0 && fields.at(-1)?.trim() === "") fields.pop();
  return fields;
}

function texasToday(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function integer(value: string, label: string): number {
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed))
    throw new RowError(`${label} must be an integer; observed ${JSON.stringify(value)}`);
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed))
    throw new RowError(`${label} is outside the safe integer range`);
  return parsed;
}

function normalizeLabel(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function baseDate(row: readonly string[], source: ExportSource, today: string): string {
  const config = GAME_MANIFEST[source.game];
  const expectedText = `${config.name}${source.session ? ` ${source.session}` : ""}`;
  if (normalizeLabel(row[0] ?? "") !== normalizeLabel(expectedText)) {
    throw new RowError(
      `unexpected game label ${JSON.stringify(row[0] ?? "")}; expected exactly ${JSON.stringify(expectedText)}`
    );
  }
  const month = integer(row[1] ?? "", "draw month");
  const day = integer(row[2] ?? "", "draw day");
  const year = integer(row[3] ?? "", "draw year");
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    throw new RowError(`invalid draw date columns ${JSON.stringify(row.slice(1, 4))}`);
  }
  const result = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (result > today) throw new RowError(`draw date ${result} is in the future`);
  return result;
}

function requireLaunch(drawDate: string, launch: string, name: string): void {
  if (drawDate < launch)
    throw new RowError(`${name} did not launch until ${launch}; observed ${drawDate}`);
}

function requireSessionLaunch(
  source: ExportSource,
  drawDate: string,
  launches: Readonly<Record<Exclude<Session, "">, string>>
): void {
  if (!source.session) throw new RowError("session-specific parser received an empty session");
  const launch = launches[source.session];
  if (drawDate < launch) {
    throw new RowError(
      `${GAME_MANIFEST[source.game].name} ${source.session} did not launch until ${launch}; observed ${drawDate}`
    );
  }
}

function requireWidth(row: readonly string[], expected: number, era: string): void {
  if (row.length !== expected) {
    throw new RowError(`expected ${expected} columns for ${era}; observed ${row.length}`);
  }
}

function values(
  candidates: readonly number[],
  count: number,
  low: number,
  high: number,
  duplicates: boolean,
  label: string
): readonly number[] {
  if (candidates.length !== count)
    throw new RowError(`expected ${count} ${label} values; observed ${candidates.length}`);
  const outside = candidates.filter((value) => value < low || value > high);
  if (outside.length > 0)
    throw new RowError(`${label} values outside ${low}..${high}: ${outside.join(", ")}`);
  if (!duplicates && new Set(candidates).size !== candidates.length) {
    throw new RowError(`duplicate ${label} values are illegal: ${candidates.join(", ")}`);
  }
  return candidates;
}

function numericTail(row: readonly string[]): number[] {
  return row.slice(4).map((value) => integer(value, "result field"));
}

function weekday(drawDate: string): number {
  return new Date(`${drawDate}T00:00:00Z`).getUTCDay();
}

function scheduled(game: GameCode, drawDate: string): boolean {
  const day = weekday(drawDate);
  if (game === "lotto" || game === "pb") {
    return (drawDate >= "2021-08-23" ? [1, 3, 6] : [3, 6]).includes(day);
  }
  if (game === "twostep") return (drawDate >= "2004-06-28" ? [1, 4] : [2, 5]).includes(day);
  if (game === "cash5") {
    if (drawDate >= "2002-07-29") return [1, 2, 3, 4, 5, 6].includes(day);
    if (drawDate >= "1996-11-25") return [1, 2, 4, 5].includes(day);
    return [2, 5].includes(day);
  }
  if (game === "mm") return [2, 5].includes(day);
  return [1, 2, 3, 4, 5, 6].includes(day);
}

function draw(
  source: ExportSource,
  drawDate: string,
  orderedNumbers: readonly number[],
  bonusNumbers: readonly number[],
  metadata: Record<string, number | string>,
  sourceLine: number,
  rawRecord: string
): ParsedDraw {
  if (!scheduled(source.game, drawDate)) {
    metadata.schedule_anomaly = `${drawDate} is outside the configured historical weekday cadence`;
  }
  const canonicalNumbers = [...orderedNumbers].sort((left, right) => left - right);
  const fingerprint = [
    source.game,
    drawDate,
    source.session,
    orderedNumbers.join(","),
    bonusNumbers.join(","),
    JSON.stringify(metadata)
  ].join("|");
  return {
    game: source.game,
    drawDate,
    session: source.session,
    orderedNumbers,
    canonicalNumbers,
    bonusNumbers,
    metadata,
    sourceLine,
    rawRecord,
    fingerprint
  };
}

function parseRow(
  row: readonly string[],
  source: ExportSource,
  sourceLine: number,
  rawRecord: string,
  today: string
): ParsedDraw {
  const drawDate = baseDate(row, source, today);
  const config = GAME_MANIFEST[source.game];

  if (source.game === "lotto") {
    requireLaunch(drawDate, "1992-11-14", config.name);
    const tail = numericTail(row);
    if (drawDate >= "2003-05-07" && drawDate <= "2006-04-22") {
      return draw(
        source,
        drawDate,
        values(tail.slice(0, 5), 5, 1, 44, false, "main"),
        values(tail.slice(5), 1, 1, 44, false, "bonus"),
        { rules_era: "5/44-plus-bonus" },
        sourceLine,
        rawRecord
      );
    }
    const maximum = drawDate < "2000-07-19" ? 50 : 54;
    return draw(
      source,
      drawDate,
      values(tail, 6, 1, maximum, false, "main"),
      [],
      { rules_era: `6/${maximum}` },
      sourceLine,
      rawRecord
    );
  }

  if (source.game === "cash5") {
    requireLaunch(drawDate, "1995-10-13", config.name);
    const [maximum, era] =
      drawDate >= "2018-09-24"
        ? [35, "5/35"]
        : drawDate >= "2002-07-29"
          ? [37, "5/37"]
          : [39, "5/39"];
    return draw(
      source,
      drawDate,
      values(numericTail(row), 5, 1, maximum as number, false, "main"),
      [],
      { rules_era: era as string },
      sourceLine,
      rawRecord
    );
  }

  if (source.game === "twostep") {
    requireLaunch(drawDate, "2001-05-18", config.name);
    const tail = numericTail(row);
    return draw(
      source,
      drawDate,
      values(tail.slice(0, 4), 4, 1, 35, false, "main"),
      values(tail.slice(4), 1, 1, 35, false, "bonus"),
      { rules_era: "4/35+1/35" },
      sourceLine,
      rawRecord
    );
  }

  if (source.game === "pb") {
    requireLaunch(drawDate, "2010-02-03", config.name);
    if (drawDate <= "2012-01-14") requireWidth(row, 11, "2010-02-03 through 2012-01-14 Powerball");
    else if (drawDate <= "2014-01-18")
      requireWidth(row, 10, "2012-01-18 through 2014-01-18 Powerball");
    else requireWidth(row, 11, "2014-01-22 onward Powerball");
    const tail = numericTail(row);
    const era =
      drawDate >= "2015-10-07"
        ? { main: 69, bonus: 26, name: "5/69+1/26" }
        : drawDate >= "2012-01-18"
          ? { main: 59, bonus: 35, name: "5/59+1/35" }
          : { main: 59, bonus: 39, name: "5/59+1/39" };
    const metadata: Record<string, number | string> = { rules_era: era.name };
    if (tail.length === 7) {
      const allowTen =
        (drawDate >= "2010-05-01" && drawDate <= "2010-06-12") || drawDate >= "2015-10-07";
      const allowed = allowTen ? [2, 3, 4, 5, 10] : [2, 3, 4, 5];
      if (!allowed.includes(tail[6] ?? -1))
        throw new RowError(`Power Play multiplier is invalid for ${drawDate}`);
      metadata.power_play = tail[6] as number;
    }
    return draw(
      source,
      drawDate,
      values(tail.slice(0, 5), 5, 1, era.main, false, "main"),
      values(tail.slice(5, 6), 1, 1, era.bonus, false, "Powerball"),
      metadata,
      sourceLine,
      rawRecord
    );
  }

  if (source.game === "mm") {
    requireLaunch(drawDate, "2003-12-05", config.name);
    requireWidth(
      row,
      drawDate < "2025-04-08" ? 11 : 10,
      drawDate < "2025-04-08"
        ? "pre-2025 Mega Millions with Megaplier"
        : "2025 onward Mega Millions"
    );
    const tail = numericTail(row);
    const era =
      drawDate >= "2025-04-08"
        ? { main: 70, bonus: 24, name: "5/70+1/24" }
        : drawDate >= "2017-10-31"
          ? { main: 70, bonus: 25, name: "5/70+1/25" }
          : drawDate >= "2013-10-22"
            ? { main: 75, bonus: 15, name: "5/75+1/15" }
            : drawDate >= "2005-06-24"
              ? { main: 56, bonus: 46, name: "5/56+1/46" }
              : { main: 52, bonus: 52, name: "legacy-5/52" };
    const metadata: Record<string, number | string> = { rules_era: era.name };
    if (tail.length === 7) {
      const allowed = drawDate >= "2013-10-22" ? [2, 3, 4, 5] : [2, 3, 4];
      if (!allowed.includes(tail[6] ?? -1))
        throw new RowError(`Megaplier is invalid for ${drawDate}`);
      metadata.megaplier = tail[6] as number;
    }
    return draw(
      source,
      drawDate,
      values(tail.slice(0, 5), 5, 1, era.main, false, "main"),
      values(tail.slice(5, 6), 1, 1, era.bonus, false, "Mega Ball"),
      metadata,
      sourceLine,
      rawRecord
    );
  }

  if (source.game === "p3") {
    requireSessionLaunch(source, drawDate, {
      night: "1993-10-25",
      day: "2002-04-29",
      morning: "2013-09-09",
      evening: "2013-09-09"
    });
    const fields = row.slice(4).map((value) => value.trim());
    const numbers = values(
      fields.slice(0, 3).map((value) => integer(value, "digit")),
      3,
      0,
      9,
      true,
      "digit"
    );
    const metadata: Record<string, number | string> = {};
    if (drawDate >= "2019-04-29") {
      requireWidth(row, 9, "2019-04-29 onward Pick 3 FIREBALL");
      if (fields[3] !== "")
        throw new RowError("Pick 3 FIREBALL era requires a blank retired Sum It Up column");
      const fireball = integer(fields[4] ?? "", "FIREBALL");
      if (fireball < 0 || fireball > 9)
        throw new RowError(`FIREBALL must be 0..9; observed ${fireball}`);
      Object.assign(metadata, { feature_name: "fireball", feature_value: fireball });
    } else if (
      (drawDate >= "2010-10-04" && drawDate <= "2010-10-30") ||
      (drawDate >= "2011-04-04" && drawDate <= "2011-04-30")
    ) {
      requireWidth(row, 9, "Green Ball promotional Pick 3");
      const total = integer(fields[3] ?? "", "Sum It Up");
      if (total !== numbers.reduce((sum, value) => sum + value, 0))
        throw new RowError("Sum It Up does not equal the digit sum");
      const greenBall = (fields[4] ?? "").toUpperCase();
      if (greenBall !== "Y" && greenBall !== "N")
        throw new RowError("Green Ball indicator must be Y or N");
      Object.assign(metadata, {
        feature_name: "sum_it_up",
        feature_value: total,
        green_ball_drawn: greenBall
      });
    } else if (drawDate >= "2007-11-12") {
      requireWidth(row, 8, "2007-11-12 through 2019-04-27 Pick 3 Sum It Up");
      const total = integer(fields[3] ?? "", "Sum It Up");
      if (total !== numbers.reduce((sum, value) => sum + value, 0))
        throw new RowError("Sum It Up does not equal the digit sum");
      Object.assign(metadata, { feature_name: "sum_it_up", feature_value: total });
    } else requireWidth(row, 7, "pre-2007 Pick 3");
    return draw(source, drawDate, numbers, [], metadata, sourceLine, rawRecord);
  }

  if (source.game === "d4") {
    requireSessionLaunch(source, drawDate, {
      day: "2007-10-01",
      night: "2007-10-01",
      morning: "2013-09-09",
      evening: "2013-09-09"
    });
    const fields = row.slice(4).map((value) => value.trim());
    const numbers = values(
      fields.slice(0, 4).map((value) => integer(value, "digit")),
      4,
      0,
      9,
      true,
      "digit"
    );
    let metadata: Record<string, number | string>;
    if (drawDate >= "2019-04-29") {
      requireWidth(row, 10, "2019-04-29 onward Daily 4 FIREBALL");
      if (fields[4] !== "")
        throw new RowError("Daily 4 FIREBALL era requires a blank retired Sum It Up column");
      const fireball = integer(fields[5] ?? "", "FIREBALL");
      if (fireball < 0 || fireball > 9)
        throw new RowError(`FIREBALL must be 0..9; observed ${fireball}`);
      metadata = { feature_name: "fireball", feature_value: fireball };
    } else {
      requireWidth(row, 9, "pre-2019 Daily 4 Sum It Up");
      const total = integer(fields[4] ?? "", "Sum It Up");
      if (total !== numbers.reduce((sum, value) => sum + value, 0))
        throw new RowError("Sum It Up does not equal the digit sum");
      metadata = { feature_name: "sum_it_up", feature_value: total };
    }
    return draw(source, drawDate, numbers, [], metadata, sourceLine, rawRecord);
  }

  requireLaunch(drawDate, "2012-09-10", config.name);
  return draw(
    source,
    drawDate,
    values(numericTail(row), 12, 1, 24, false, "main"),
    [],
    { rules_era: "12/24" },
    sourceLine,
    rawRecord
  );
}

export function parseOfficialCsv(
  text: string,
  source: ExportSource,
  now: Date = new Date()
): ParseResult {
  if (/^\s*(?:<!doctype\s+html|<html)/i.test(text)) {
    throw new SchemaMismatchError(
      `Schema mismatch for ${source.id}: received HTML, not the documented Texas Lottery CSV`
    );
  }

  const draws: ParsedDraw[] = [];
  const issues: ParseIssue[] = [];
  const widths = new Map<number, number>();
  const recordLines: number[] = [];
  const identities = new Set<string>();
  const today = texasToday(now);
  const physicalLines = text.replace(/^\uFEFF/, "").split(/\r?\n/);

  for (let index = 0; index < physicalLines.length; index += 1) {
    const rawRecord = physicalLines[index]?.replace(/\r$/, "") ?? "";
    if (!rawRecord.trim()) continue;
    const sourceLine = index + 1;
    recordLines.push(sourceLine);
    try {
      const row = csvLine(rawRecord);
      widths.set(row.length, (widths.get(row.length) ?? 0) + 1);
      if (!source.expectedWidths.includes(row.length)) {
        throw new RowError(
          `expected ${source.expectedWidths.join(" or ")} columns; observed ${row.length}`
        );
      }
      const parsed = parseRow(row, source, sourceLine, rawRecord, today);
      const identity = `${parsed.game}|${parsed.drawDate}|${parsed.session}`;
      if (identities.has(identity)) throw new RowError(`duplicate natural key ${identity}`);
      identities.add(identity);
      draws.push(parsed);
    } catch (error) {
      issues.push({
        sourceLine,
        rawRecord,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const totalRows = recordLines.length;
  if (totalRows === 0)
    throw new SchemaMismatchError(`Schema mismatch for ${source.id}: export is empty`);
  const issueLines = new Set(issues.map((issue) => issue.sourceLine));
  const trailingDrift =
    recordLines.length >= 2 && recordLines.slice(-2).every((line) => issueLines.has(line));
  const invalidRatio = issues.length / totalRows;
  if (draws.length === 0 || trailingDrift || (issues.length >= 2 && invalidRatio > 0.2)) {
    const observed = Object.fromEntries(
      [...widths.entries()].map(([width, count]) => [String(width), count])
    );
    const examples = issues
      .slice(0, 3)
      .map((issue) => `line ${issue.sourceLine}: ${issue.reason}`)
      .join("; ");
    throw new SchemaMismatchError(
      `Schema mismatch for ${source.id}. Expected column counts ${source.expectedWidths.join(", ")}; ` +
        `observed ${JSON.stringify(observed)}. Valid rows=${draws.length}, invalid rows=${issues.length} ` +
        `(${(invalidRatio * 100).toFixed(1)}%). Consecutive invalid tail detected=${trailingDrift}. ` +
        `Examples: ${examples || "none"}. The official file layout may have changed.`,
      issues
    );
  }

  return {
    draws,
    issues,
    totalRows,
    observedWidths: Object.fromEntries(
      [...widths.entries()].map(([width, count]) => [String(width), count])
    )
  };
}
