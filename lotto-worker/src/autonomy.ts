import { calculateEv } from "../../web/lib/lotto/ev";
import { generateTickets } from "../../web/lib/lotto/picker";
import type { DigitPlayStyle, Ticket } from "../../web/lib/lotto/types";

import type { Env } from "./env";
import { refreshSource, type IngestOutcome } from "./ingest";
import { GAME_MANIFEST, type GameCode } from "./manifest";
import {
  drawSlot as canonicalDrawSlot,
  drawWeekdays,
  GENERATION_DEADLINE_HOUR,
  isConfiguredDue,
  isDrawDay,
  isGenerationTimeBeforeDeadline,
  isPastGenerationDeadline,
  officialDrawWeekdays,
  parseLocalTime,
  parseWeekdays,
  previousConfiguredDrawDate,
  texasDayUtcBounds,
  texasClock,
  ticketSalesWindow,
  type DrawSlot
} from "./scheduler";
import {
  generationLedgerStatements,
  reconcileLegacyRandomBaselines,
  reconcileResultNotifications
} from "./ticket-lab";

export const PICKS_DISCLAIMER =
  "Picks are optimized for coverage and lower split-risk patterns, not predicted. Lottery draws are random. Play responsibly.";
const MAX_PIPELINE_ATTEMPTS = 3;
interface GenerationRow {
  run_id: string;
  game: GameCode;
  draw_date: string;
  draw_slot: DrawSlot;
  scheduled_for: string;
  seed: string;
  status: "running" | "failed" | "generated";
  pipeline_attempts: number;
  next_retry_at: string | null;
  started_at: string;
  generated_at: string | null;
  observed_through: string | null;
  dataset_digest: string | null;
  source_state_json: string;
  ticket_count: number;
  distinct_pairs: number;
  possible_pairs: number;
  coverage_basis_points: number;
  ev_net_cents: number | null;
  ev_assumption: string | null;
  message_body: string | null;
  disclaimer: string;
  error: string | null;
}

interface TicketRow {
  run_id: string;
  ordinal: number;
  main_numbers: string;
  bonus_numbers: string;
  play_style: string;
  split_risk_basis_points: number;
  split_risk_level: "low" | "moderate" | "high";
  split_risk_notes: string;
}

interface SourceVerificationRow {
  source_id: string;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_digest: string | null;
  last_status: string;
  active_count: number;
  latest_draw_date: string | null;
  consecutive_failures: number;
}

interface IntegrityRow {
  active_count: number;
  invalid_json: number;
  source_count: number;
}

interface GameAutomationConfigRow {
  game: GameCode;
  selected: number;
  ticket_count: number;
  generation_weekdays: string;
  generation_local_time: string;
  draw_slot: DrawSlot;
  play_style: string;
  jackpot_cents: number;
  estimated_sales: number;
  popularity_ppm: number;
  config_version: number;
}

interface AutomationConfigInspection {
  readonly row: GameAutomationConfigRow;
  readonly config: GameAutomationConfigRow | null;
  readonly error: string | null;
}

export interface PublicGeneratedTicket {
  readonly ordinal: number;
  readonly main: readonly number[];
  readonly bonus: readonly number[];
  readonly playStyle: string;
  readonly splitRiskScore: number;
  readonly splitRiskLevel: "low" | "moderate" | "high";
  readonly splitRiskNotes: readonly string[];
}

export interface PublicGenerationRun {
  readonly runId: string;
  readonly game: GameCode;
  readonly gameName: string;
  readonly drawDate: string;
  readonly drawSlot: DrawSlot;
  readonly scheduledFor: string;
  readonly generatedAt: string;
  readonly seed: string;
  readonly observedThrough: string;
  readonly datasetDigest: string;
  readonly coverage: {
    readonly distinctPairs: number;
    readonly possiblePairs: number;
    readonly coveragePercent: number;
  };
  readonly ev: {
    readonly netCentsPerTicket: number;
    readonly assumption: string;
  };
  readonly tickets: readonly PublicGeneratedTicket[];
  readonly generationLogUrl: string;
  readonly disclaimer: string;
}

export type AutomationOutcome =
  | { readonly kind: "generated" | "reused"; readonly run: PublicGenerationRun }
  | {
      readonly kind: "failed";
      readonly game: GameCode;
      readonly drawDate: string;
      readonly attempts: number;
      readonly terminal: boolean;
      readonly error: string;
    }
  | { readonly kind: "idle"; readonly due: readonly GameCode[] };

async function acquireGenerationLease(
  env: Env,
  game: GameCode,
  drawDate: string,
  now: Date
): Promise<string | null> {
  const leaseToken = crypto.randomUUID();
  const acquiredAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 15 * 60_000).toISOString();
  const result = await env.LOTTO_DB.prepare(
    `INSERT INTO lotto_generation_leases
       (game, draw_date, lease_token, lease_expires_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?5)
     ON CONFLICT(game, draw_date) DO UPDATE SET
       lease_token = excluded.lease_token,
       lease_expires_at = excluded.lease_expires_at,
       updated_at = excluded.updated_at
     WHERE lotto_generation_leases.lease_expires_at <= ?5`
  )
    .bind(game, drawDate, leaseToken, expiresAt, acquiredAt)
    .run();
  return (result.meta.changes ?? 0) === 1 ? leaseToken : null;
}

async function releaseGenerationLease(
  env: Env,
  game: GameCode,
  drawDate: string,
  leaseToken: string
): Promise<void> {
  await env.LOTTO_DB.prepare(
    `DELETE FROM lotto_generation_leases
     WHERE game = ?1 AND draw_date = ?2 AND lease_token = ?3`
  )
    .bind(game, drawDate, leaseToken)
    .run();
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(
    0,
    2_000
  );
}

function decodeIntegerArray(value: string, field: string): readonly number[] {
  const decoded: unknown = JSON.parse(value);
  if (!Array.isArray(decoded) || !decoded.every((item) => Number.isSafeInteger(item))) {
    throw new Error(`Stored ${field} is invalid`);
  }
  return decoded as number[];
}

function decodeStringArray(value: string, field: string): readonly string[] {
  const decoded: unknown = JSON.parse(value);
  if (!Array.isArray(decoded) || !decoded.every((item) => typeof item === "string")) {
    throw new Error(`Stored ${field} is invalid`);
  }
  return decoded as string[];
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function deriveProtectedDailySeed(
  seedSalt: string,
  game: GameCode,
  drawDate: string,
  slot: DrawSlot
): Promise<string> {
  const secret = seedSalt.trim();
  if (secret.length < 32)
    throw new Error("RABBITHOLETX_SEED_SALT must contain at least 32 characters");
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(deterministicDailySeed(game, drawDate, slot))
  );
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  );
}

export function deterministicDailySeed(game: GameCode, drawDate: string, slot: DrawSlot): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(drawDate)) throw new RangeError("draw date must be ISO-8601");
  return `rabbitholetx:v1:${game}:${drawDate}:${slot}`;
}

function money(cents: number): string {
  const rounded = Math.round(cents);
  const sign = rounded < 0 ? "-" : "";
  return `${sign}$${(Math.abs(rounded) / 100).toFixed(2)}`;
}

function displayDate(drawDate: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric"
  }).format(new Date(`${drawDate}T12:00:00Z`));
}

function displayTicket(game: GameCode, ticket: Ticket): string {
  const config = GAME_MANIFEST[game];
  const main =
    config.kind === "digits"
      ? ticket.main.join("")
      : ticket.main.map((value) => String(value).padStart(2, "0")).join("-");
  const bonus = (ticket.bonus ?? []).map((value) => String(value).padStart(2, "0")).join("-");
  return bonus ? `${main} + ${bonus}` : main;
}

function formatMessage(
  game: GameCode,
  drawDate: string,
  tickets: readonly Ticket[],
  coveragePercent: number,
  netEvCents: number,
  observedThrough: string,
  evBasis: string
): string {
  const renderedTickets = tickets.map((ticket) => displayTicket(game, ticket)).join(" | ");
  const digitGuidance =
    GAME_MANIFEST[game].kind === "digits"
      ? ` | ${tickets[0]?.playStyle ?? "straight"} play; exact/box choice changes EV; no digit is due`
      : "";
  return (
    `🐰 RabbitHoleTX — ${GAME_MANIFEST[game].name} (${displayDate(drawDate)}): ` +
    `${renderedTickets} | coverage ${coveragePercent.toFixed(2)}% | ` +
    `EV ${money(netEvCents)}/ticket (${evBasis})${digitGuidance} | ` +
    `data through ${observedThrough}. ` +
    "Optimized, not predicted. Play responsibly."
  );
}

function evDescription(config: GameAutomationConfigRow): {
  readonly assumption: string;
  readonly messageBasis: string;
} {
  const popularity = (config.popularity_ppm / 1_000_000).toFixed(3);
  if (config.game === "p3" || config.game === "d4") {
    return {
      assumption: `Pre-tax fixed-prize ${config.play_style} model.`,
      messageBasis: "fixed-prize model"
    };
  }
  if (["lotto", "twostep", "pb", "mm"].includes(config.game)) {
    return {
      assumption:
        `Pre-tax model: cash jackpot ${money(config.jackpot_cents)}, ` +
        `${config.estimated_sales} estimated plays, popularity multiplier ${popularity}.`,
      messageBasis:
        config.jackpot_cents === 0
          ? "jackpot excluded; cash jackpot unset"
          : config.estimated_sales === 0
            ? "jackpot included; split risk unmodeled"
            : "configured cash-jackpot/split model"
    };
  }
  return {
    assumption:
      `Pre-tax liability-cap model: ${config.estimated_sales} estimated plays, ` +
      `popularity multiplier ${popularity}.`,
    messageBasis:
      config.estimated_sales > 0
        ? "configured liability-cap split model"
        : "liability-cap splitting unmodeled"
  };
}

async function verificationState(
  env: Env,
  game: GameCode,
  drawDate: string,
  outcomes: readonly IngestOutcome[]
): Promise<{
  readonly observedThrough: string;
  readonly datasetDigest: string;
  readonly sourceStateJson: string;
  readonly quarantined: number;
}> {
  const sourceResult = await env.LOTTO_DB.prepare(
    `SELECT source_id, last_attempt_at, last_success_at, last_digest, last_status,
            active_count, latest_draw_date, consecutive_failures
     FROM lotto_sources WHERE game = ?1 AND enabled = 1 ORDER BY source_id`
  )
    .bind(game)
    .all<SourceVerificationRow>();
  const expected = GAME_MANIFEST[game].sources.length;
  if (sourceResult.results.length !== expected) {
    throw new Error(`integrity check found ${sourceResult.results.length}/${expected} sources`);
  }
  for (const source of sourceResult.results) {
    if (
      source.active_count <= 0 ||
      source.latest_draw_date === null ||
      source.last_digest === null ||
      source.last_attempt_at === null ||
      !["complete", "complete-with-quarantine", "cache-fallback"].includes(source.last_status)
    ) {
      throw new Error(`source ${source.source_id} is not generation-ready (${source.last_status})`);
    }
  }
  const integrity = await env.LOTTO_DB.prepare(
    `SELECT COUNT(*) AS active_count,
            COALESCE(SUM(CASE WHEN json_valid(ordered_numbers) = 0
                                   OR json_valid(canonical_numbers) = 0
                                   OR json_valid(bonus_numbers) = 0
                                   OR json_valid(metadata) = 0 THEN 1 ELSE 0 END), 0) AS invalid_json,
            COUNT(DISTINCT source_id) AS source_count
     FROM lotto_draws WHERE game = ?1 AND active = 1`
  )
    .bind(game)
    .first<IntegrityRow>();
  if (
    !integrity ||
    Number(integrity.active_count) <= 0 ||
    Number(integrity.invalid_json) !== 0 ||
    Number(integrity.source_count) !== expected
  ) {
    throw new Error(`draw integrity check failed for ${game}`);
  }
  const states = sourceResult.results.map((source) => ({
    sourceId: source.source_id,
    digest: source.last_digest,
    observedThrough: source.latest_draw_date,
    lastAttemptAt: source.last_attempt_at,
    lastSuccessAt: source.last_success_at,
    status: source.last_status,
    activeCount: source.active_count
  }));
  const observedThrough = states
    .map((source) => source.observedThrough as string)
    .sort()[0] as string;
  const expectedThrough = previousConfiguredDrawDate(drawDate, officialDrawWeekdays(game));
  if (observedThrough < expectedThrough || observedThrough > drawDate) {
    throw new Error(
      `source freshness check failed for ${game}: observed through ${observedThrough}, ` +
        `expected at least ${expectedThrough} and no later than draw date ${drawDate}`
    );
  }
  const sourceStateJson = JSON.stringify(states);
  return {
    observedThrough,
    datasetDigest: await sha256(sourceStateJson),
    sourceStateJson,
    quarantined: outcomes.reduce((total, outcome) => total + outcome.quarantined, 0)
  };
}

async function generatedRun(
  env: Env,
  game: GameCode,
  drawDate: string,
  apiBase = "/api/lotto/v1"
): Promise<PublicGenerationRun | null> {
  const row = await env.LOTTO_DB.prepare(
    `SELECT * FROM lotto_generation_runs
     WHERE game = ?1 AND draw_date = ?2 AND status = 'generated'`
  )
    .bind(game, drawDate)
    .first<GenerationRow>();
  if (!row) return null;
  const tickets = await env.LOTTO_DB.prepare(
    `SELECT run_id, ordinal, main_numbers, bonus_numbers, play_style,
            split_risk_basis_points, split_risk_level, split_risk_notes
     FROM lotto_generated_tickets WHERE run_id = ?1 ORDER BY ordinal`
  )
    .bind(row.run_id)
    .all<TicketRow>();
  if (tickets.results.length !== row.ticket_count) {
    throw new Error(`Run ${row.run_id} ticket count does not reconcile`);
  }
  return publicRun(row, tickets.results, apiBase);
}

function validateAutomationConfigRow(row: GameAutomationConfigRow): GameAutomationConfigRow {
  if (!Object.prototype.hasOwnProperty.call(GAME_MANIFEST, row.game)) {
    throw new Error(`Unknown game in autonomous configuration: ${JSON.stringify(row.game)}`);
  }
  if (!Number.isSafeInteger(row.ticket_count) || row.ticket_count < 1 || row.ticket_count > 50) {
    throw new Error(`Invalid ticket count for ${row.game}`);
  }
  for (const [field, value] of [
    ["jackpot_cents", row.jackpot_cents],
    ["estimated_sales", row.estimated_sales],
    ["popularity_ppm", row.popularity_ppm]
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Invalid ${field} EV input for ${row.game}`);
    }
  }
  if (!Number.isSafeInteger(row.config_version) || row.config_version < 1) {
    throw new Error(`Invalid config version for ${row.game}`);
  }
  const fixedPrizeGame = row.game === "p3" || row.game === "d4";
  const rolloverGame = ["lotto", "twostep", "pb", "mm"].includes(row.game);
  if (!rolloverGame && row.jackpot_cents !== 0) {
    throw new Error(`Jackpot EV input does not apply to ${row.game}`);
  }
  if (fixedPrizeGame && (row.estimated_sales !== 0 || row.popularity_ppm !== 1_000_000)) {
    throw new Error(`Sales and popularity EV inputs do not apply to ${row.game}`);
  }
  const weekdays = parseWeekdays(row.generation_weekdays);
  const canonicalWeekdays = drawWeekdays(row.game);
  if (
    weekdays.length !== canonicalWeekdays.length ||
    weekdays.some((weekday) => !canonicalWeekdays.includes(weekday))
  ) {
    throw new Error(`Generation weekdays for ${row.game} do not match its canonical schedule`);
  }
  parseLocalTime(row.generation_local_time);
  if (!isGenerationTimeBeforeDeadline(row.generation_local_time)) {
    throw new Error(
      `Generation time for ${row.game} must be before ` +
        `${String(GENERATION_DEADLINE_HOUR).padStart(2, "0")}:00 America/Chicago`
    );
  }
  if (row.draw_slot !== canonicalDrawSlot(row.game)) {
    throw new Error(`Draw slot for ${row.game} does not match its canonical schedule`);
  }
  if (row.play_style !== "straight") {
    throw new Error(
      `Autonomous play style for ${row.game} must be straight so one persisted ` +
        "per-ticket EV remains valid for every generated digit pattern"
    );
  }
  return row;
}

function inspectAutomationConfig(row: GameAutomationConfigRow): AutomationConfigInspection {
  try {
    return { row, config: validateAutomationConfigRow(row), error: null };
  } catch (error) {
    return { row, config: null, error: boundedError(error) };
  }
}

async function automationConfigRows(
  env: Env,
  selectedOnly = true
): Promise<GameAutomationConfigRow[]> {
  const result = await env.LOTTO_DB.prepare(
    `SELECT game, selected, ticket_count, generation_weekdays, generation_local_time,
            draw_slot, play_style, jackpot_cents, estimated_sales, popularity_ppm, config_version
     FROM lotto_game_config
     ${selectedOnly ? "WHERE selected = 1" : ""}
     ORDER BY CASE game
       WHEN 'lotto' THEN 1 WHEN 'twostep' THEN 2 WHEN 'cash5' THEN 3 WHEN 'pb' THEN 4
       WHEN 'mm' THEN 5 WHEN 'p3' THEN 6 WHEN 'd4' THEN 7 WHEN 'aon' THEN 8 END`
  ).all<GameAutomationConfigRow>();
  return result.results;
}

export async function automationConfigs(
  env: Env,
  selectedOnly = true
): Promise<GameAutomationConfigRow[]> {
  return (await automationConfigRows(env, selectedOnly)).map(validateAutomationConfigRow);
}

async function automationConfig(env: Env, game: GameCode): Promise<GameAutomationConfigRow> {
  const config = await env.LOTTO_DB.prepare(
    `SELECT game, selected, ticket_count, generation_weekdays, generation_local_time,
            draw_slot, play_style, jackpot_cents, estimated_sales, popularity_ppm, config_version
     FROM lotto_game_config WHERE game = ?1`
  )
    .bind(game)
    .first<GameAutomationConfigRow>();
  if (!config) throw new Error(`Autonomous configuration is missing for ${game}`);
  return validateAutomationConfigRow(config);
}

function fallbackAutomationConfig(row: GameAutomationConfigRow): GameAutomationConfigRow {
  return {
    game: row.game,
    selected: row.selected,
    ticket_count: 4,
    generation_weekdays: JSON.stringify(drawWeekdays(row.game)),
    generation_local_time: "06:00",
    draw_slot: canonicalDrawSlot(row.game),
    play_style: "straight",
    jackpot_cents: 0,
    estimated_sales: 0,
    popularity_ppm: 1_000_000,
    config_version: Math.max(1, Number.isSafeInteger(row.config_version) ? row.config_version : 1)
  };
}

function inspectionIsDue(
  inspection: AutomationConfigInspection,
  clock: ReturnType<typeof texasClock>
): boolean {
  const config = inspection.config ?? fallbackAutomationConfig(inspection.row);
  return isConfiguredDue(
    clock,
    inspection.config ? parseWeekdays(config.generation_weekdays) : drawWeekdays(config.game),
    config.generation_local_time
  );
}

async function selectedDueCount(env: Env, clock: ReturnType<typeof texasClock>): Promise<number> {
  const rows = await automationConfigRows(env);
  return rows
    .map(inspectAutomationConfig)
    .filter((inspection) => inspectionIsDue(inspection, clock)).length;
}

function publicRun(
  row: GenerationRow,
  tickets: readonly TicketRow[],
  apiBase: string
): PublicGenerationRun {
  if (
    row.generated_at === null ||
    row.observed_through === null ||
    row.dataset_digest === null ||
    row.ev_net_cents === null ||
    row.ev_assumption === null
  ) {
    throw new Error(`Generated run ${row.run_id} is incomplete`);
  }
  return {
    runId: row.run_id,
    game: row.game,
    gameName: GAME_MANIFEST[row.game].name,
    drawDate: row.draw_date,
    drawSlot: row.draw_slot,
    scheduledFor: row.scheduled_for,
    generatedAt: row.generated_at,
    seed: row.seed,
    observedThrough: row.observed_through,
    datasetDigest: row.dataset_digest,
    coverage: {
      distinctPairs: row.distinct_pairs,
      possiblePairs: row.possible_pairs,
      coveragePercent: row.coverage_basis_points / 100
    },
    ev: { netCentsPerTicket: row.ev_net_cents, assumption: row.ev_assumption },
    tickets: tickets.map((ticket) => ({
      ordinal: ticket.ordinal,
      main: decodeIntegerArray(ticket.main_numbers, "main numbers"),
      bonus: decodeIntegerArray(ticket.bonus_numbers, "bonus numbers"),
      playStyle: ticket.play_style,
      splitRiskScore: ticket.split_risk_basis_points / 100,
      splitRiskLevel: ticket.split_risk_level,
      splitRiskNotes: decodeStringArray(ticket.split_risk_notes, "split-risk notes")
    })),
    generationLogUrl: `${apiBase}/generation-runs/${encodeURIComponent(row.run_id)}`,
    disclaimer: row.disclaimer
  };
}

export async function refreshDailySummary(
  env: Env,
  serviceDate: string,
  dueCount: number,
  _quarantinedDelta: number,
  now: string
): Promise<void> {
  const serviceDay = texasDayUtcBounds(serviceDate);
  const counts = await env.LOTTO_DB.prepare(
    `SELECT
       SUM(CASE WHEN status = 'generated' THEN 1 ELSE 0 END) AS generated_games,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_games
     FROM lotto_generation_runs WHERE draw_date = ?1`
  )
    .bind(serviceDate)
    .first<{ generated_games: number | null; failed_games: number | null }>();
  const deliveries = await env.LOTTO_DB.prepare(
    `SELECT
       SUM(CASE WHEN o.status IN ('pending', 'leased', 'retry') THEN 1 ELSE 0 END) AS pending_deliveries,
       SUM(CASE WHEN o.status = 'sent' THEN 1 ELSE 0 END) AS sent_deliveries,
       SUM(CASE WHEN o.status IN ('ambiguous', 'dead') THEN 1 ELSE 0 END) AS failed_deliveries,
       SUM(CASE WHEN o.delivery_kind = 'alert' OR COALESCE(o.alert_status, '') <> ''
                THEN 1 ELSE 0 END) AS alert_deliveries,
       SUM(CASE WHEN (o.delivery_kind = 'alert' AND o.status = 'sent')
                       OR (o.delivery_kind = 'picks' AND o.alert_status = 'sent')
                THEN 1 ELSE 0 END) AS sent_alerts,
       SUM(CASE WHEN (o.delivery_kind = 'alert' AND o.status IN ('ambiguous', 'dead'))
                       OR o.alert_status IN ('failed', 'ambiguous')
                THEN 1 ELSE 0 END) AS failed_alerts
     FROM lotto_delivery_outbox o
     JOIN lotto_generation_runs r ON r.run_id = o.run_id
     WHERE r.draw_date = ?1`
  )
    .bind(serviceDate)
    .first<{
      pending_deliveries: number | null;
      sent_deliveries: number | null;
      failed_deliveries: number | null;
      alert_deliveries: number | null;
      sent_alerts: number | null;
      failed_alerts: number | null;
    }>();
  const quarantine = await env.LOTTO_DB.prepare(
    `SELECT COUNT(*) AS quarantined_records
     FROM lotto_quarantine q
     WHERE q.created_at >= ?1 AND q.created_at < ?2`
  )
    .bind(serviceDay.start, serviceDay.end)
    .first<{ quarantined_records: number }>();
  const sourceFreshness = await env.LOTTO_DB.prepare(
    `SELECT game, MAX(last_success_at) AS last_success_at,
            MIN(latest_draw_date) AS observed_through,
            SUM(active_count) AS active_draws
     FROM lotto_sources
     WHERE enabled = 1
     GROUP BY game
     ORDER BY game`
  ).all<{
    game: GameCode;
    last_success_at: string | null;
    observed_through: string | null;
    active_draws: number;
  }>();
  const quarantinedRecords = Number(quarantine?.quarantined_records ?? 0);
  const payload = {
    dueGames: dueCount,
    generatedGames: Number(counts?.generated_games ?? 0),
    failedGames: Number(counts?.failed_games ?? 0),
    pendingDeliveries: Number(deliveries?.pending_deliveries ?? 0),
    sentDeliveries: Number(deliveries?.sent_deliveries ?? 0),
    failedDeliveries: Number(deliveries?.failed_deliveries ?? 0),
    alertDeliveries: Number(deliveries?.alert_deliveries ?? 0),
    sentAlerts: Number(deliveries?.sent_alerts ?? 0),
    failedAlerts: Number(deliveries?.failed_alerts ?? 0),
    quarantinedRecords,
    dataFreshness: Object.fromEntries(
      sourceFreshness.results.map((source) => [
        source.game,
        {
          lastSuccessfulIngest: source.last_success_at,
          observedThrough: source.observed_through,
          activeDraws: Number(source.active_draws)
        }
      ])
    ),
    updatedAt: now
  };
  await env.LOTTO_DB.prepare(
    `INSERT INTO lotto_daily_summaries
       (service_date, due_games, generated_games, failed_games, pending_deliveries,
        sent_deliveries, quarantined_records, summary_json, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
     ON CONFLICT(service_date) DO UPDATE SET
       due_games = excluded.due_games,
       generated_games = excluded.generated_games,
       failed_games = excluded.failed_games,
       pending_deliveries = excluded.pending_deliveries,
       sent_deliveries = excluded.sent_deliveries,
       quarantined_records = excluded.quarantined_records,
       summary_json = excluded.summary_json,
       updated_at = excluded.updated_at`
  )
    .bind(
      serviceDate,
      payload.dueGames,
      payload.generatedGames,
      payload.failedGames,
      payload.pendingDeliveries,
      payload.sentDeliveries,
      payload.quarantinedRecords,
      JSON.stringify(payload),
      now
    )
    .run();
}

async function recordFailure(
  env: Env,
  game: GameCode,
  drawDate: string,
  config: GameAutomationConfigRow,
  runId: string,
  seed: string,
  error: unknown,
  now: Date,
  missedDeadline: boolean
): Promise<AutomationOutcome> {
  const prior = await env.LOTTO_DB.prepare(
    `SELECT pipeline_attempts FROM lotto_generation_runs
     WHERE game = ?1 AND draw_date = ?2`
  )
    .bind(game, drawDate)
    .first<{ pipeline_attempts: number }>();
  const attempts = Number(prior?.pipeline_attempts ?? 0) + 1;
  const terminal = missedDeadline || attempts >= MAX_PIPELINE_ATTEMPTS;
  const occurredAt = now.toISOString();
  const nextRetryAt = terminal ? null : new Date(now.getTime() + 60_000).toISOString();
  const message = boundedError(error);
  const statements: D1PreparedStatement[] = [
    env.LOTTO_DB.prepare(
      `INSERT INTO lotto_generation_runs
         (run_id, game, draw_date, draw_slot, scheduled_for, seed, status,
          pipeline_attempts, next_retry_at, started_at, disclaimer, error, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'failed', ?7, ?8, ?9, ?10, ?11, ?9, ?9)
       ON CONFLICT(game, draw_date) DO UPDATE SET
         status = CASE WHEN lotto_generation_runs.status = 'generated' THEN 'generated' ELSE 'failed' END,
         pipeline_attempts = CASE WHEN lotto_generation_runs.status = 'generated'
                                  THEN lotto_generation_runs.pipeline_attempts ELSE excluded.pipeline_attempts END,
         next_retry_at = CASE WHEN lotto_generation_runs.status = 'generated'
                              THEN lotto_generation_runs.next_retry_at ELSE excluded.next_retry_at END,
         error = CASE WHEN lotto_generation_runs.status = 'generated'
                      THEN lotto_generation_runs.error ELSE excluded.error END,
         updated_at = excluded.updated_at`
    ).bind(
      runId,
      game,
      drawDate,
      config.draw_slot,
      `${drawDate} ${config.generation_local_time} ${"America/Chicago"}`,
      seed,
      attempts,
      nextRetryAt,
      occurredAt,
      PICKS_DISCLAIMER,
      message
    )
  ];
  if (terminal || missedDeadline) {
    const alert = missedDeadline
      ? `🚨 RabbitHoleTX ALERT — ${GAME_MANIFEST[game].name} missed the official sales cutoff ` +
        `for ${drawDate}; no Ticket Lab proposal was generated. ${PICKS_DISCLAIMER}`
      : `🚨 RabbitHoleTX ALERT — generation failed for ${GAME_MANIFEST[game].name} ` +
        `(${drawDate}) after ${attempts} attempts. Needs attention. ${PICKS_DISCLAIMER}`;
    statements.push(
      env.LOTTO_DB.prepare(
        `INSERT OR IGNORE INTO lotto_delivery_outbox
           (delivery_id, run_id, delivery_kind, target_role, message_body, status,
            next_attempt_at, created_at, updated_at)
         VALUES (?1, ?2, 'alert', 'fallback', ?3, 'pending', ?4, ?4, ?4)`
      ).bind(`alert-${runId}`, runId, alert, occurredAt)
    );
  }
  await env.LOTTO_DB.batch(statements);
  console.error(
    JSON.stringify({
      service: "rabbitholetx",
      event: "generation_failed",
      game,
      drawDate,
      attempts,
      terminal,
      error: message
    })
  );
  return { kind: "failed", game, drawDate, attempts, terminal, error: message };
}

async function recordConfigurationFailure(
  env: Env,
  inspection: AutomationConfigInspection,
  now: Date
): Promise<AutomationOutcome> {
  const clock = texasClock(now);
  const game = inspection.row.game;
  const seedNamespace = deterministicDailySeed(game, clock.date, canonicalDrawSlot(game));
  const runId = `gen-${(await sha256(`run-id\0${seedNamespace}`)).slice(0, 32)}`;
  const leaseToken = await acquireGenerationLease(env, game, clock.date, now);
  if (!leaseToken) return { kind: "idle", due: [game] };
  try {
    const result = await recordFailure(
      env,
      game,
      clock.date,
      fallbackAutomationConfig(inspection.row),
      runId,
      "unavailable",
      new Error(`Autonomous configuration is invalid: ${inspection.error ?? "unknown error"}`),
      now,
      !ticketSalesWindow(
        game,
        clock.date,
        game === "p3" || game === "d4" || game === "aon" ? "morning" : "",
        now
      ).beforeCutoff
    );
    await refreshDailySummary(
      env,
      clock.date,
      await selectedDueCount(env, clock),
      0,
      now.toISOString()
    );
    return result;
  } finally {
    await releaseGenerationLease(env, game, clock.date, leaseToken);
  }
}

export async function generateForGame(
  env: Env,
  game: GameCode,
  now = new Date(),
  apiBase = "/api/lotto/v1",
  executionNow: () => Date = () => new Date()
): Promise<AutomationOutcome> {
  const clock = texasClock(now);
  const config = await automationConfig(env, game);
  const slot = config.draw_slot;
  const existing = await generatedRun(env, game, clock.date, apiBase);
  if (existing) return { kind: "reused", run: existing };
  const seedNamespace = deterministicDailySeed(game, clock.date, slot);
  const runId = `gen-${(await sha256(`run-id\0${seedNamespace}`)).slice(0, 32)}`;
  const leaseToken = await acquireGenerationLease(env, game, clock.date, executionNow());
  if (!leaseToken) return { kind: "idle", due: [game] };
  const ticketCount = config.ticket_count;
  let seed = "unavailable";
  try {
    const startNow = executionNow();
    const ledgerSession = game === "p3" || game === "d4" || game === "aon" ? "morning" : "";
    const startWindow = ticketSalesWindow(game, clock.date, ledgerSession, startNow);
    if (!startWindow.isDrawDay || !startWindow.beforeCutoff) {
      const reason = !startWindow.isDrawDay
        ? `${GAME_MANIFEST[game].name} has no official draw on ${clock.date}`
        : `${GAME_MANIFEST[game].name} sales closed at ${startWindow.cutoffLocalTime} for ${clock.date}`;
      const failure = await recordFailure(
        env,
        game,
        clock.date,
        config,
        runId,
        seed,
        new Error(reason),
        startNow,
        true
      );
      await refreshDailySummary(
        env,
        clock.date,
        await selectedDueCount(env, clock),
        0,
        startNow.toISOString()
      );
      return failure;
    }
    seed = await deriveProtectedDailySeed(env.RABBITHOLETX_SEED_SALT ?? "", game, clock.date, slot);
    const outcomes: IngestOutcome[] = [];
    for (const source of GAME_MANIFEST[game].sources) {
      outcomes.push(await refreshSource(env, source.id, "scheduled"));
    }
    const ingestedResult = await env.LOTTO_DB.prepare(
      `SELECT 1 AS found FROM lotto_draws
       WHERE game = ?1 AND draw_date = ?2 AND session = ?3 AND active = 1 LIMIT 1`
    )
      .bind(game, clock.date, ledgerSession)
      .first<{ found: number }>();
    if (ingestedResult) {
      throw new Error(
        `official ${GAME_MANIFEST[game].name} result already exists for ${clock.date}; post-draw generation is forbidden`
      );
    }
    const verification = await verificationState(env, game, clock.date, outcomes);
    const picked = generateTickets({
      game,
      count: ticketCount,
      seed,
      playStyle: config.play_style as DigitPlayStyle
    });
    const ev = calculateEv({
      game,
      jackpotCents: config.jackpot_cents,
      ticketSales: config.estimated_sales,
      popularityMultiplier: config.popularity_ppm / 1_000_000,
      playStyle: config.play_style as DigitPlayStyle
    });
    const completedAt = executionNow();
    const completionWindow = ticketSalesWindow(game, clock.date, ledgerSession, completedAt);
    if (!completionWindow.beforeCutoff) {
      throw new Error(
        `${GAME_MANIFEST[game].name} sales closed at ${completionWindow.cutoffLocalTime} before generation completed`
      );
    }
    const completionClock = texasClock(completedAt);
    const deadlineClock = completionClock.date === clock.date ? completionClock : clock;
    const generatedAt = completedAt.toISOString();
    const coverageBasisPoints = Math.round(picked.coverage.coveragePercent * 100);
    const netEvCents = Math.round(ev.netEvCents);
    const evDetails = evDescription(config);
    const evAssumption = evDetails.assumption;
    const messageBody = formatMessage(
      game,
      clock.date,
      picked.tickets.map((item) => item.ticket),
      picked.coverage.coveragePercent,
      netEvCents,
      verification.observedThrough,
      evDetails.messageBasis
    );
    const scheduledFor = `${clock.date} ${config.generation_local_time} America/Chicago`;
    const statements: D1PreparedStatement[] = [
      env.LOTTO_DB.prepare(
        `INSERT INTO lotto_generation_runs
           (run_id, game, draw_date, draw_slot, scheduled_for, seed, status,
            pipeline_attempts, next_retry_at, started_at, generated_at, observed_through,
            dataset_digest, source_state_json, ticket_count, distinct_pairs, possible_pairs,
            coverage_basis_points, ev_net_cents, ev_assumption, message_body, disclaimer,
            error, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'generated', 1, NULL, ?7, ?8, ?9, ?10,
                 ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, NULL, ?7, ?8)
         ON CONFLICT(game, draw_date) DO UPDATE SET
           run_id = excluded.run_id, seed = excluded.seed,
           draw_slot = excluded.draw_slot, scheduled_for = excluded.scheduled_for,
           status = 'generated', pipeline_attempts = lotto_generation_runs.pipeline_attempts + 1,
           next_retry_at = NULL, generated_at = excluded.generated_at,
           observed_through = excluded.observed_through, dataset_digest = excluded.dataset_digest,
           source_state_json = excluded.source_state_json, ticket_count = excluded.ticket_count,
           distinct_pairs = excluded.distinct_pairs, possible_pairs = excluded.possible_pairs,
           coverage_basis_points = excluded.coverage_basis_points,
           ev_net_cents = excluded.ev_net_cents, ev_assumption = excluded.ev_assumption,
           message_body = excluded.message_body, disclaimer = excluded.disclaimer,
           error = NULL, updated_at = excluded.updated_at
         WHERE lotto_generation_runs.status <> 'generated'`
      ).bind(
        runId,
        game,
        clock.date,
        slot,
        scheduledFor,
        seed,
        now.toISOString(),
        generatedAt,
        verification.observedThrough,
        verification.datasetDigest,
        verification.sourceStateJson,
        picked.tickets.length,
        picked.coverage.distinctPairs,
        picked.coverage.possiblePairs,
        coverageBasisPoints,
        netEvCents,
        evAssumption,
        messageBody,
        PICKS_DISCLAIMER
      )
    ];
    picked.tickets.forEach((item, index) => {
      statements.push(
        env.LOTTO_DB.prepare(
          `INSERT OR IGNORE INTO lotto_generated_tickets
             (run_id, ordinal, main_numbers, bonus_numbers, play_style,
              split_risk_basis_points, split_risk_level, split_risk_notes)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
        ).bind(
          runId,
          index + 1,
          JSON.stringify(item.ticket.main),
          JSON.stringify(item.ticket.bonus ?? []),
          item.ticket.playStyle ?? "straight",
          Math.round(item.splitRisk.score * 100),
          item.splitRisk.level,
          JSON.stringify(item.splitRisk.notes)
        )
      );
    });
    statements.push(
      ...(await generationLedgerStatements(env.LOTTO_DB, {
        runId,
        game,
        drawDate: clock.date,
        generatedAt,
        seed,
        tickets: picked.tickets,
        coverage: picked.coverage,
        evNetCents: netEvCents,
        evAssumption,
        ticketCostCents: ev.ticketCostCents,
        observedThrough: verification.observedThrough,
        datasetDigest: verification.datasetDigest
      }))
    );
    statements.push(
      env.LOTTO_DB.prepare(
        `INSERT OR IGNORE INTO lotto_delivery_outbox
           (delivery_id, run_id, delivery_kind, target_role, message_body, status,
            next_attempt_at, created_at, updated_at)
         VALUES (?1, ?2, 'picks', 'primary', ?3, 'pending', ?4, ?4, ?4)`
      ).bind(`delivery-${runId}`, runId, messageBody, generatedAt)
    );
    if (isPastGenerationDeadline(deadlineClock)) {
      const alert =
        `🚨 RabbitHoleTX ALERT — ${GAME_MANIFEST[game].name} generation completed after ` +
        `${String(GENERATION_DEADLINE_HOUR).padStart(2, "0")}:00 CT for ${clock.date}. ` +
        `Numbers were recovered and queued, but the timing needs attention. ${PICKS_DISCLAIMER}`;
      statements.push(
        env.LOTTO_DB.prepare(
          `INSERT INTO lotto_delivery_outbox
             (delivery_id, run_id, delivery_kind, target_role, message_body, status,
              next_attempt_at, created_at, updated_at)
           VALUES (?1, ?2, 'alert', 'fallback', ?3, 'pending', ?4, ?4, ?4)
           ON CONFLICT(delivery_id) DO UPDATE SET
             message_body = excluded.message_body,
             next_attempt_at = excluded.next_attempt_at,
             updated_at = excluded.updated_at
           WHERE lotto_delivery_outbox.status IN ('pending', 'retry')`
        ).bind(`alert-${runId}`, runId, alert, generatedAt)
      );
    }
    const commitWindow = ticketSalesWindow(game, clock.date, ledgerSession, executionNow());
    if (!commitWindow.beforeCutoff) {
      throw new Error(
        `${GAME_MANIFEST[game].name} sales closed at ${commitWindow.cutoffLocalTime} before the immutable ledger commit`
      );
    }
    await env.LOTTO_DB.batch(statements);
    await refreshDailySummary(
      env,
      clock.date,
      await selectedDueCount(env, clock),
      verification.quarantined,
      generatedAt
    );
    const run = await generatedRun(env, game, clock.date, apiBase);
    if (!run) throw new Error(`Generated run ${runId} could not be read back`);
    console.log(
      JSON.stringify({
        service: "rabbitholetx",
        event: "generation_complete",
        runId,
        game,
        drawDate: clock.date,
        ticketCount,
        coveragePercent: picked.coverage.coveragePercent,
        observedThrough: verification.observedThrough,
        quarantined: verification.quarantined
      })
    );
    return { kind: "generated", run };
  } catch (error) {
    const failedAt = executionNow();
    const ledgerSession = game === "p3" || game === "d4" || game === "aon" ? "morning" : "";
    const failure = await recordFailure(
      env,
      game,
      clock.date,
      config,
      runId,
      seed,
      error,
      failedAt,
      !ticketSalesWindow(game, clock.date, ledgerSession, failedAt).beforeCutoff
    );
    await refreshDailySummary(
      env,
      clock.date,
      await selectedDueCount(env, clock),
      0,
      new Date().toISOString()
    );
    return failure;
  } finally {
    await releaseGenerationLease(env, game, clock.date, leaseToken);
  }
}

export async function runScheduledGeneration(
  env: Env,
  now = new Date(),
  apiBase = "/api/lotto/v1"
): Promise<AutomationOutcome> {
  await reconcileLegacyRandomBaselines(env);
  await reconcileResultNotifications(env, null, new Date());
  const clock = texasClock(now);
  const inspections = (await automationConfigRows(env)).map(inspectAutomationConfig);
  const dueInspections = inspections.filter((inspection) => inspectionIsDue(inspection, clock));
  const due = dueInspections.map((inspection) => inspection.row.game);
  if (due.length === 0) return { kind: "idle", due };
  const existing = await env.LOTTO_DB.prepare(
    `SELECT game, status, pipeline_attempts, next_retry_at
     FROM lotto_generation_runs WHERE draw_date = ?1`
  )
    .bind(clock.date)
    .all<{
      game: GameCode;
      status: "running" | "failed" | "generated";
      pipeline_attempts: number;
      next_retry_at: string | null;
    }>();
  const byGame = new Map(existing.results.map((row) => [row.game, row]));
  const neverAttempted = dueInspections.find((inspection) => !byGame.has(inspection.row.game));
  if (neverAttempted) {
    return neverAttempted.config
      ? generateForGame(env, neverAttempted.row.game, now, apiBase)
      : recordConfigurationFailure(env, neverAttempted, now);
  }
  const retryable = dueInspections.find((inspection) => {
    const row = byGame.get(inspection.row.game);
    return (
      row?.status === "failed" &&
      row.pipeline_attempts < MAX_PIPELINE_ATTEMPTS &&
      row.next_retry_at !== null &&
      row.next_retry_at <= now.toISOString()
    );
  });
  if (retryable) {
    return retryable.config
      ? generateForGame(env, retryable.row.game, now, apiBase)
      : recordConfigurationFailure(env, retryable, now);
  }
  return { kind: "idle", due };
}

export async function listGeneratedRuns(
  env: Env,
  drawDate: string,
  apiBase = "/api/lotto/v1"
): Promise<readonly PublicGenerationRun[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(drawDate)) throw new RangeError("draw date must be ISO-8601");
  const runs = await env.LOTTO_DB.prepare(
    `SELECT * FROM lotto_generation_runs
     WHERE draw_date = ?1 AND status = 'generated' ORDER BY game, draw_slot`
  )
    .bind(drawDate)
    .all<GenerationRow>();
  if (runs.results.length === 0) return [];
  const tickets = await env.LOTTO_DB.prepare(
    `SELECT t.run_id, t.ordinal, t.main_numbers, t.bonus_numbers, t.play_style,
            t.split_risk_basis_points, t.split_risk_level, t.split_risk_notes
     FROM lotto_generated_tickets t
     JOIN lotto_generation_runs r ON r.run_id = t.run_id
     WHERE r.draw_date = ?1 AND r.status = 'generated'
     ORDER BY t.run_id, t.ordinal`
  )
    .bind(drawDate)
    .all<TicketRow>();
  const grouped = new Map<string, TicketRow[]>();
  for (const ticket of tickets.results) {
    const collection = grouped.get(ticket.run_id) ?? [];
    collection.push(ticket);
    grouped.set(ticket.run_id, collection);
  }
  return runs.results.map((run) => publicRun(run, grouped.get(run.run_id) ?? [], apiBase));
}

export async function generationRunById(
  env: Env,
  runId: string,
  apiBase = "/api/lotto/v1"
): Promise<PublicGenerationRun | null> {
  if (!/^gen-[a-f0-9]{32}$/.test(runId)) throw new RangeError("generation run id is malformed");
  const row = await env.LOTTO_DB.prepare(
    `SELECT * FROM lotto_generation_runs WHERE run_id = ?1 AND status = 'generated'`
  )
    .bind(runId)
    .first<GenerationRow>();
  if (!row) return null;
  const tickets = await env.LOTTO_DB.prepare(
    `SELECT run_id, ordinal, main_numbers, bonus_numbers, play_style,
            split_risk_basis_points, split_risk_level, split_risk_notes
     FROM lotto_generated_tickets WHERE run_id = ?1 ORDER BY ordinal`
  )
    .bind(runId)
    .all<TicketRow>();
  return publicRun(row, tickets.results, apiBase);
}

export interface PublicServiceStatus {
  readonly timeZone: "America/Chicago";
  readonly asOf: string;
  readonly missedGenerationGames: readonly GameCode[];
  readonly games: readonly {
    readonly game: GameCode;
    readonly gameName: string;
    readonly selected: boolean;
    readonly ticketCount: number;
    readonly generationWeekdays: readonly string[];
    readonly generationLocalTime: string;
    readonly drawSlot: DrawSlot;
    readonly configurationValid: boolean;
    readonly configurationError: string | null;
    readonly generationDue: boolean;
    readonly generationMissed: boolean;
    readonly pendingDeliveries: number;
    readonly failedDeliveries: number;
    readonly unresolvedAlerts: number;
    readonly quarantinedRecords: number;
    readonly lastError: string | null;
    readonly attentionRequired: boolean;
    readonly lastIngest: {
      readonly at: string | null;
      readonly observedThrough: string | null;
      readonly readySources: number;
      readonly sourceCount: number;
      readonly activeDraws: number;
      readonly status: "ready" | "degraded";
    };
    readonly lastGeneration: null | {
      readonly drawDate: string;
      readonly status: "running" | "failed" | "generated";
      readonly at: string;
      readonly attempts: number;
      readonly error: string | null;
    };
    readonly lastDelivery: null | {
      readonly status: string;
      readonly at: string;
      readonly deliveredAt: string | null;
      readonly attempts: number;
    };
  }[];
  readonly latestDailySummary: null | Readonly<Record<string, unknown>>;
}

export async function readServiceStatus(env: Env, now = new Date()): Promise<PublicServiceStatus> {
  const clock = texasClock(now);
  const serviceDay = texasDayUtcBounds(clock.date);
  const inspections = (await automationConfigRows(env, false)).map(inspectAutomationConfig);
  const runs = await env.LOTTO_DB.prepare(
    `SELECT game, draw_date, status, pipeline_attempts, started_at, generated_at, updated_at, error
     FROM lotto_generation_runs ORDER BY draw_date DESC, updated_at DESC`
  ).all<{
    game: GameCode;
    draw_date: string;
    status: "running" | "failed" | "generated";
    pipeline_attempts: number;
    started_at: string;
    generated_at: string | null;
    updated_at: string;
    error: string | null;
  }>();
  const deliveries = await env.LOTTO_DB.prepare(
    `SELECT r.game, o.delivery_kind, o.status, o.updated_at, o.delivered_at, o.attempt_count,
            o.external_id, o.last_error, o.alert_status, o.alert_external_id, o.alert_error
     FROM lotto_delivery_outbox o
     JOIN lotto_generation_runs r ON r.run_id = o.run_id
     ORDER BY o.updated_at DESC, o.delivery_id`
  ).all<{
    game: GameCode;
    delivery_kind: "picks" | "alert";
    status: string;
    updated_at: string;
    delivered_at: string | null;
    attempt_count: number;
    external_id: string | null;
    last_error: string | null;
    alert_status: string | null;
    alert_external_id: string | null;
    alert_error: string | null;
  }>();
  const sources = await env.LOTTO_DB.prepare(
    `SELECT game, last_success_at, last_status, latest_draw_date, active_count
     FROM lotto_sources WHERE enabled = 1 ORDER BY game, source_id`
  ).all<{
    game: GameCode;
    last_success_at: string | null;
    last_status: string;
    latest_draw_date: string | null;
    active_count: number;
  }>();
  const lastRun = new Map<GameCode, (typeof runs.results)[number]>();
  for (const run of runs.results) if (!lastRun.has(run.game)) lastRun.set(run.game, run);
  const lastDelivery = new Map<GameCode, (typeof deliveries.results)[number]>();
  for (const delivery of deliveries.results) {
    if (delivery.delivery_kind === "picks" && !lastDelivery.has(delivery.game)) {
      lastDelivery.set(delivery.game, delivery);
    }
  }
  const deliveryState = new Map<
    GameCode,
    {
      pending: number;
      failed: number;
      unresolvedAlerts: number;
      error: string | null;
    }
  >();
  for (const delivery of deliveries.results) {
    const state = deliveryState.get(delivery.game) ?? {
      pending: 0,
      failed: 0,
      unresolvedAlerts: 0,
      error: null
    };
    if (["pending", "leased", "retry"].includes(delivery.status)) state.pending += 1;
    if (["ambiguous", "dead"].includes(delivery.status)) state.failed += 1;
    const directAlertUnresolved =
      delivery.delivery_kind === "alert" &&
      (delivery.status !== "sent" || !delivery.external_id?.trim());
    const attachedAlertUnresolved =
      delivery.delivery_kind === "picks" &&
      delivery.alert_status !== null &&
      (delivery.alert_status !== "sent" || !delivery.alert_external_id?.trim());
    if (directAlertUnresolved || attachedAlertUnresolved) state.unresolvedAlerts += 1;
    if (state.error === null) {
      const error = delivery.last_error?.trim() || delivery.alert_error?.trim();
      if (
        error &&
        (["pending", "leased", "retry", "ambiguous", "dead"].includes(delivery.status) ||
          attachedAlertUnresolved)
      ) {
        state.error = error;
      }
    }
    deliveryState.set(delivery.game, state);
  }
  const quarantine = await env.LOTTO_DB.prepare(
    `SELECT q.game AS game, COUNT(*) AS quarantined_records
     FROM lotto_quarantine q
     WHERE q.created_at >= ?1 AND q.created_at < ?2
     GROUP BY q.game`
  )
    .bind(serviceDay.start, serviceDay.end)
    .all<{ game: GameCode; quarantined_records: number }>();
  const quarantinedByGame = new Map(
    quarantine.results.map((row) => [row.game, Number(row.quarantined_records)])
  );
  const summary = await env.LOTTO_DB.prepare(
    `SELECT summary_json FROM lotto_daily_summaries ORDER BY service_date DESC LIMIT 1`
  ).first<{ summary_json: string }>();
  let latestDailySummary: Readonly<Record<string, unknown>> | null = null;
  if (summary) {
    const parsed: unknown = JSON.parse(summary.summary_json);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      latestDailySummary = parsed as Record<string, unknown>;
    }
  }
  return {
    timeZone: "America/Chicago",
    asOf: now.toISOString(),
    missedGenerationGames: inspections
      .filter(
        (inspection) =>
          inspection.row.selected === 1 &&
          isDrawDay(inspection.row.game, clock) &&
          isPastGenerationDeadline(clock) &&
          !runs.results.some(
            (run) =>
              run.game === inspection.row.game &&
              run.draw_date === clock.date &&
              run.status === "generated"
          )
      )
      .map((inspection) => inspection.row.game),
    games: inspections.map((inspection) => {
      const config = inspection.row;
      const run = lastRun.get(config.game);
      const delivery = lastDelivery.get(config.game);
      const operational = deliveryState.get(config.game) ?? {
        pending: 0,
        failed: 0,
        unresolvedAlerts: 0,
        error: null
      };
      const gameSources = sources.results.filter((source) => source.game === config.game);
      const readySources = gameSources.filter(
        (source) =>
          source.last_success_at !== null &&
          source.latest_draw_date !== null &&
          source.active_count > 0 &&
          [
            "complete",
            "complete-with-quarantine",
            "cache-fallback",
            "unchanged",
            "bootstrap"
          ].includes(source.last_status)
      );
      const successfulIngests = gameSources
        .map((source) => source.last_success_at)
        .filter((value): value is string => value !== null)
        .sort();
      const observedDates = readySources
        .map((source) => source.latest_draw_date)
        .filter((value): value is string => value !== null)
        .sort();
      const expectedSourceCount = GAME_MANIFEST[config.game].sources.length;
      const observedThrough =
        gameSources.length === expectedSourceCount && readySources.length === expectedSourceCount
          ? (observedDates[0] ?? null)
          : null;
      const expectedThrough = previousConfiguredDrawDate(
        clock.date,
        officialDrawWeekdays(config.game)
      );
      const ingestReady =
        observedThrough !== null &&
        observedThrough >= expectedThrough &&
        observedThrough <= clock.date;
      const generationDue = config.selected === 1 && inspectionIsDue(inspection, clock);
      const generatedToday = runs.results.some(
        (candidate) =>
          candidate.game === config.game &&
          candidate.draw_date === clock.date &&
          candidate.status === "generated"
      );
      const generationMissed =
        config.selected === 1 &&
        isDrawDay(config.game, clock) &&
        isPastGenerationDeadline(clock) &&
        !generatedToday;
      let generationWeekdays: readonly string[];
      try {
        generationWeekdays = parseWeekdays(config.generation_weekdays);
      } catch {
        generationWeekdays = [];
      }
      const quarantinedRecords = quarantinedByGame.get(config.game) ?? 0;
      const latestRunError = run?.status === "failed" ? run.error : null;
      const lastError =
        (config.selected === 1 ? inspection.error : null) ??
        (generationMissed
          ? `${GAME_MANIFEST[config.game].name} has no generated picks for ${clock.date} after 09:00 CT`
          : null) ??
        latestRunError ??
        operational.error ??
        (operational.failed > 0
          ? `${operational.failed} ${operational.failed === 1 ? "delivery has" : "deliveries have"} failed or ambiguous confirmation`
          : null) ??
        (operational.unresolvedAlerts > 0
          ? `${operational.unresolvedAlerts} alert${operational.unresolvedAlerts === 1 ? " is" : "s are"} unresolved`
          : null) ??
        (config.selected === 1 && !ingestReady
          ? `Official draw archive is not current through ${expectedThrough}`
          : null) ??
        (quarantinedRecords > 0
          ? `${quarantinedRecords} quarantined draw record${quarantinedRecords === 1 ? "" : "s"}`
          : null) ??
        (operational.pending > 0
          ? `${operational.pending} delivery${operational.pending === 1 ? " is" : "ies are"} pending`
          : null);
      const attentionRequired =
        (config.selected === 1 &&
          (inspection.config === null ||
            !ingestReady ||
            generationMissed ||
            run?.status === "failed")) ||
        operational.pending > 0 ||
        operational.failed > 0 ||
        operational.unresolvedAlerts > 0 ||
        quarantinedRecords > 0;
      return {
        game: config.game,
        gameName: GAME_MANIFEST[config.game].name,
        selected: config.selected === 1,
        ticketCount: config.ticket_count,
        generationWeekdays,
        generationLocalTime: config.generation_local_time,
        drawSlot: config.draw_slot,
        configurationValid: inspection.config !== null,
        configurationError: inspection.error,
        generationDue,
        generationMissed,
        pendingDeliveries: operational.pending,
        failedDeliveries: operational.failed,
        unresolvedAlerts: operational.unresolvedAlerts,
        quarantinedRecords,
        lastError,
        attentionRequired,
        lastIngest: {
          at: successfulIngests.at(-1) ?? null,
          observedThrough,
          readySources: readySources.length,
          sourceCount: expectedSourceCount,
          activeDraws: gameSources.reduce(
            (total, source) => total + Number(source.active_count),
            0
          ),
          status: ingestReady ? "ready" : "degraded"
        },
        lastGeneration: run
          ? {
              drawDate: run.draw_date,
              status: run.status,
              at: run.generated_at ?? run.updated_at ?? run.started_at,
              attempts: run.pipeline_attempts,
              error: run.error
            }
          : null,
        lastDelivery: delivery
          ? {
              status: delivery.status,
              at: delivery.updated_at,
              deliveredAt: delivery.delivered_at,
              attempts: delivery.attempt_count
            }
          : null
      };
    }),
    latestDailySummary
  };
}
