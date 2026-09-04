import { GAME_CODES, type GameCode, type Session } from "./manifest";

export type DrawSlot = "daily" | "morning";

export interface TexasClock {
  readonly date: string;
  readonly weekday: "Sun" | "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat";
  readonly hour: number;
  readonly minute: number;
}

const WEEKDAYS: Readonly<Record<GameCode, readonly TexasClock["weekday"][]>> = {
  lotto: ["Mon", "Wed"],
  twostep: ["Mon", "Thu"],
  cash5: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  pb: ["Wed", "Sat"],
  mm: ["Tue", "Fri"],
  p3: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  d4: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  aon: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
};
const OFFICIAL_DRAW_WEEKDAYS: Readonly<Record<GameCode, readonly TexasClock["weekday"][]>> = {
  lotto: ["Mon", "Wed", "Sat"],
  twostep: ["Mon", "Thu"],
  cash5: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  pb: ["Mon", "Wed", "Sat"],
  mm: ["Tue", "Fri"],
  p3: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  d4: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  aon: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
};
const WEEKDAY_BY_UTC_DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const INTRADAY_CUTOFF_MINUTES: Readonly<Record<Exclude<Session, "">, number>> = {
  morning: 9 * 60 + 50,
  day: 12 * 60 + 17,
  evening: 17 * 60 + 50,
  night: 22 * 60 + 2
};

const POOL_CUTOFF_MINUTES: Readonly<Record<Exclude<GameCode, "p3" | "d4" | "aon">, number>> = {
  lotto: 22 * 60 + 2,
  twostep: 22 * 60 + 2,
  cash5: 22 * 60 + 2,
  pb: 21 * 60,
  mm: 21 * 60 + 45
};

export const SCHEDULER_TIME_ZONE = "America/Chicago";
export const GENERATION_DEADLINE_HOUR = 9;

export function texasClock(now: Date): TexasClock {
  if (!Number.isFinite(now.getTime())) throw new RangeError("scheduler date must be valid");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SCHEDULER_TIME_ZONE,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now);
  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  const weekday = read("weekday");
  if (
    !(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const).some(
      (candidate) => candidate === weekday
    )
  ) {
    throw new Error(`Intl returned unsupported weekday ${JSON.stringify(weekday)}`);
  }
  const hour = Number(read("hour"));
  const minute = Number(read("minute"));
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new Error("Intl returned an invalid Texas wall-clock time");
  }
  return {
    date: `${read("year")}-${read("month")}-${read("day")}`,
    weekday: weekday as TexasClock["weekday"],
    hour,
    minute
  };
}

function nextIsoDate(value: string): string {
  const parsed = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new RangeError("date must be a valid ISO-8601 calendar date");
  }
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10);
}

function texasMidnight(value: string): Date {
  for (let utcHour = 4; utcHour <= 8; utcHour += 1) {
    const candidate = new Date(`${value}T${String(utcHour).padStart(2, "0")}:00:00.000Z`);
    const clock = texasClock(candidate);
    if (clock.date === value && clock.hour === 0 && clock.minute === 0) return candidate;
  }
  throw new RangeError(`could not resolve Texas midnight for ${value}`);
}

export function texasDayUtcBounds(value: string): {
  readonly start: string;
  readonly end: string;
} {
  const start = texasMidnight(value);
  const end = texasMidnight(nextIsoDate(value));
  return { start: start.toISOString(), end: end.toISOString() };
}

export function drawSlot(game: GameCode): DrawSlot {
  return game === "aon" ? "morning" : "daily";
}

export function isDrawDay(game: GameCode, clock: TexasClock): boolean {
  return WEEKDAYS[game].includes(clock.weekday);
}

export function drawWeekdays(game: GameCode): readonly TexasClock["weekday"][] {
  return WEEKDAYS[game];
}

export function officialDrawWeekdays(game: GameCode): readonly TexasClock["weekday"][] {
  return OFFICIAL_DRAW_WEEKDAYS[game];
}

function weekdayForIsoDate(value: string): TexasClock["weekday"] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new RangeError("draw date must be ISO-8601");
  const parsed = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new RangeError("draw date must be a valid calendar date");
  }
  return WEEKDAY_BY_UTC_DAY[parsed.getUTCDay()] as TexasClock["weekday"];
}

/** The official Texas sales cutoff, expressed as minutes after local midnight. */
export function ticketSalesCutoffMinutes(game: GameCode, session: Session): number {
  if (game === "p3" || game === "d4" || game === "aon") {
    if (session === "") throw new RangeError(`${game} requires an explicit draw session`);
    return INTRADAY_CUTOFF_MINUTES[session];
  }
  if (session !== "") throw new RangeError(`${game} does not use an intraday draw session`);
  return POOL_CUTOFF_MINUTES[game];
}

export interface TicketSalesWindow {
  readonly isDrawDay: boolean;
  readonly beforeCutoff: boolean;
  readonly cutoffLocalTime: string;
}

/**
 * Evaluate the pre-draw evidence boundary using the server clock in Central Time.
 * Caller-provided timestamps are intentionally irrelevant to this decision.
 */
export function ticketSalesWindow(
  game: GameCode,
  drawDate: string,
  session: Session,
  now: Date
): TicketSalesWindow {
  const cutoff = ticketSalesCutoffMinutes(game, session);
  const isOfficialDay = OFFICIAL_DRAW_WEEKDAYS[game].includes(weekdayForIsoDate(drawDate));
  const clock = texasClock(now);
  const beforeCutoff =
    isOfficialDay &&
    (drawDate > clock.date || (drawDate === clock.date && clock.hour * 60 + clock.minute < cutoff));
  const hour = Math.floor(cutoff / 60);
  const minute = cutoff % 60;
  return {
    isDrawDay: isOfficialDay,
    beforeCutoff,
    cutoffLocalTime: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} CT`
  };
}

export function previousConfiguredDrawDate(
  drawDate: string,
  weekdays: readonly TexasClock["weekday"][]
): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(drawDate) || weekdays.length === 0) {
    throw new RangeError("draw date and configured weekdays are required");
  }
  const candidate = new Date(`${drawDate}T12:00:00Z`);
  if (!Number.isFinite(candidate.getTime()) || candidate.toISOString().slice(0, 10) !== drawDate) {
    throw new RangeError("draw date must be a valid ISO-8601 calendar date");
  }
  for (let offset = 1; offset <= 7; offset += 1) {
    candidate.setUTCDate(candidate.getUTCDate() - 1);
    if (weekdays.includes(WEEKDAY_BY_UTC_DAY[candidate.getUTCDay()] as TexasClock["weekday"])) {
      return candidate.toISOString().slice(0, 10);
    }
  }
  throw new RangeError("configured weekdays must include at least one valid weekday");
}

export function dueGames(
  now: Date,
  selectedGames: readonly GameCode[],
  generationHour: number
): readonly GameCode[] {
  if (!Number.isInteger(generationHour) || generationHour < 0 || generationHour > 23) {
    throw new RangeError("generation hour must be an integer from 0 through 23");
  }
  const clock = texasClock(now);
  if (clock.hour < generationHour) return [];
  return selectedGames.filter((game) => isDrawDay(game, clock));
}

export function parseSelectedGames(raw: string): readonly GameCode[] {
  const values = raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (values.length === 0) throw new RangeError("AUTONOMOUS_SELECTED_GAMES cannot be empty");
  const unique = new Set<GameCode>();
  for (const value of values) {
    if (!(GAME_CODES as readonly string[]).includes(value)) {
      throw new RangeError(`Unknown configured game ${JSON.stringify(value)}`);
    }
    unique.add(value as GameCode);
  }
  return GAME_CODES.filter((game) => unique.has(game));
}

export function parseGenerationHour(raw: string): number {
  if (!/^\d{1,2}$/.test(raw.trim())) {
    throw new RangeError("AUTONOMOUS_GENERATION_HOUR_CT must be an integer from 0 through 23");
  }
  const value = Number(raw);
  if (value < 0 || value > 23) {
    throw new RangeError("AUTONOMOUS_GENERATION_HOUR_CT must be an integer from 0 through 23");
  }
  return value;
}

export function parseTicketCount(raw: string): number {
  if (!/^\d+$/.test(raw.trim())) {
    throw new RangeError("AUTONOMOUS_TICKETS_PER_GAME must be an integer from 1 through 50");
  }
  const value = Number(raw);
  if (value < 1 || value > 50) {
    throw new RangeError("AUTONOMOUS_TICKETS_PER_GAME must be an integer from 1 through 50");
  }
  return value;
}

export function parseLocalTime(raw: string): { readonly hour: number; readonly minute: number } {
  const match = raw.trim().match(/^(\d{2}):(\d{2})$/);
  if (!match) throw new RangeError("generation local time must use HH:MM");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new RangeError("generation local time is invalid");
  return { hour, minute };
}

export function parseWeekdays(raw: string): readonly TexasClock["weekday"][] {
  const decoded: unknown = JSON.parse(raw);
  const allowed = new Set<TexasClock["weekday"]>(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
  if (
    !Array.isArray(decoded) ||
    decoded.length === 0 ||
    !decoded.every(
      (value) => typeof value === "string" && allowed.has(value as TexasClock["weekday"])
    )
  ) {
    throw new RangeError("generation weekdays must be a non-empty JSON weekday array");
  }
  return [...new Set(decoded as TexasClock["weekday"][])];
}

export function isConfiguredDue(
  clock: TexasClock,
  weekdays: readonly TexasClock["weekday"][],
  localTime: string
): boolean {
  const scheduled = parseLocalTime(localTime);
  return (
    weekdays.includes(clock.weekday) &&
    (clock.hour > scheduled.hour ||
      (clock.hour === scheduled.hour && clock.minute >= scheduled.minute))
  );
}

export function isGenerationTimeBeforeDeadline(localTime: string): boolean {
  const scheduled = parseLocalTime(localTime);
  return scheduled.hour < GENERATION_DEADLINE_HOUR;
}

export function isPastGenerationDeadline(clock: TexasClock): boolean {
  return clock.hour >= GENERATION_DEADLINE_HOUR;
}
