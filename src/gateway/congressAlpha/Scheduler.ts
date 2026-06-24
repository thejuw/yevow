import { DEFAULT_SCHEDULER_TIMEZONE } from "./Common";

export interface CongressAlphaSchedulerStatus {
  autoRunEnabled: boolean;
  timezone: string;
  localDate: string;
  localTime: string;
  expectedWindowLocal: string;
  nextRunLocalDate: string;
  nextRunLocalTime: string;
  nextRunHint: string;
  lastScheduledRunAt: string | null;
}

export function localTimeParts(
  date: Date,
  timeZone: string
): { date: string; hour: string; minute: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const lookup = new Map(parts.map((part) => [part.type, part.value]));

  return {
    date: `${lookup.get("year")}-${lookup.get("month")}-${lookup.get("day")}`,
    hour: lookup.get("hour") ?? "00",
    minute: lookup.get("minute") ?? "00"
  };
}

export function buildSchedulerStatus(input: {
  autoRunEnabled: boolean;
  timezone?: string;
  now?: Date;
  lastScheduledRunAt?: string | null;
}): CongressAlphaSchedulerStatus {
  const timezone = input.timezone ?? DEFAULT_SCHEDULER_TIMEZONE;
  const now = input.now ?? new Date();
  const local = localTimeParts(now, timezone);
  const nextRunLocalDate =
    local.hour === "00" && local.minute === "00" ? local.date : nextLocalDate(local.date);

  return {
    autoRunEnabled: input.autoRunEnabled,
    timezone,
    localDate: local.date,
    localTime: `${local.hour}:${local.minute}`,
    expectedWindowLocal: "00:00",
    nextRunLocalDate,
    nextRunLocalTime: "00:00",
    nextRunHint: input.autoRunEnabled
      ? `Next eligible scheduler window is ${nextRunLocalDate} 00:00 ${timezone}.`
      : "Automatic midnight rebalance is disabled in Congress Alpha settings.",
    lastScheduledRunAt: input.lastScheduledRunAt ?? null
  };
}

function nextLocalDate(yyyyMmDd: string): string {
  const [year, month, day] = yyyyMmDd.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + 1));
  return date.toISOString().slice(0, 10);
}
