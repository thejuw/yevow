/** Forward-only, paper-only experiments. No purchase or messaging writes exist here. */
import { generateChallenger, type ChallengerId } from "../../web/lib/lotto/challenger";
import type { DigitPlayStyle, Ticket } from "../../web/lib/lotto/types";
import { validateTicket } from "../../web/lib/lotto/validation";
import type { Env } from "./env";
import { GAME_MANIFEST, type GameCode, type Session } from "./manifest";
import { ensureOfficialPayoutMetadata, readOfficialPayoutMetadata } from "./payouts";
import { texasClock, ticketSalesWindow } from "./scheduler";
import { gradeTicket, type TicketLabFilters } from "./ticket-lab";

const PROTOCOL = "forward-2026-09-v1";
const REVIEW_DATE = "2026-12-20";
const ARMS = ["challenger", "current", "random"] as const;
type Arm = (typeof ARMS)[number];
export const SHADOW_DISCLAIMER =
  "Paper-only forward experiments; no extra purchases or SMS picks. Picks are optimized, not predicted. " +
  "No automatic promotion. More frequent prizes do not imply better expected dollar return.";

const VARIANTS = [
  {
    id: "neutral-v1",
    version: "1",
    label: "Neutral selection",
    goal: "Uniform legal distinct tickets; no popularity exclusions"
  },
  {
    id: "aon-prize-v1",
    version: "1",
    label: "All or Nothing prize-aware",
    goal: "Maximize simulated probability of any prize; not expected dollars"
  },
  {
    id: "bonus-diversity-v1",
    version: "1",
    label: "Bonus diversification",
    goal: "Spread bonus-only prize exposure at unchanged cost"
  }
] as const;

interface ParentRow {
  ledger_id: string;
  baseline_id: string;
  game: GameCode;
  draw_date: string;
  target_session: Session;
  proposed_at: string;
  seed: string;
  ticket_count: number;
  ticket_cost_cents: number;
  observed_through: string;
  dataset_digest: string;
  eligible: number;
  baseline_eligible: number;
}

interface StoredTicket {
  ledger_id: string;
  ordinal: number;
  main_numbers: string;
  bonus_numbers: string;
  play_style: DigitPlayStyle;
  wager_cents: number;
  ticket_options_json: string;
}

interface FrozenTicket extends Ticket {
  readonly bonus: readonly number[];
  readonly playStyle: DigitPlayStyle;
  readonly wagerCents: number;
  readonly options: Readonly<Record<string, unknown>>;
}

type FrozenArms = Record<Arm, readonly FrozenTicket[]>;
interface TrialRow {
  trial_id: string;
  parent_ledger_id: string;
  baseline_ledger_id: string;
  variant_id: ChallengerId;
  optimizer_version: string;
  protocol_version: string;
  game: GameCode;
  draw_date: string;
  target_session: Session;
  proposed_at: string;
  seed: string;
  objective: string;
  config_hash: string;
  config_json: string;
  observed_through: string;
  dataset_digest: string;
  ticket_count: number;
  wager_cents: number;
  arms_json: string;
  metrics_json: string;
}

interface GradeArm {
  readonly cashCents: number;
  readonly nonCashValueCents: number;
  readonly pendingPrizeCount: number;
  readonly hits: number;
  readonly tickets: readonly ReturnType<typeof gradeTicket>[];
}
type GradedArms = Record<Arm, GradeArm>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectJson(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!record(parsed)) throw new Error("Shadow evidence must be an object");
  return parsed;
}

function numbers(value: string): number[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((n) => Number.isSafeInteger(n))) {
    throw new Error("Shadow ticket/result has invalid numbers");
  }
  return parsed;
}

async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((v) => v.toString(16).padStart(2, "0")).join("");
}

function variantsFor(game: GameCode): readonly ChallengerId[] {
  if (game === "aon") return ["neutral-v1", "aon-prize-v1"];
  if (GAME_MANIFEST[game].bonus) return ["neutral-v1", "bonus-diversity-v1"];
  return ["neutral-v1"];
}

function freezeTicket(game: GameCode, row: StoredTicket): FrozenTicket {
  const ticket = {
    game,
    main: numbers(row.main_numbers),
    bonus: numbers(row.bonus_numbers),
    playStyle: row.play_style,
    wagerCents: row.wager_cents,
    options: objectJson(row.ticket_options_json)
  };
  validateTicket(game, ticket);
  if (
    ticket.playStyle !== "straight" ||
    ticket.wagerCents !== GAME_MANIFEST[game].baseCostCents ||
    ticket.options.extra === true ||
    ticket.options.fireball === true ||
    ticket.options.powerPlay === true
  ) {
    throw new Error("Shadow protocol v1 requires equal-cost base straight play without add-ons");
  }
  return ticket;
}

function parseArms(row: TrialRow): FrozenArms {
  const parsed = objectJson(row.arms_json);
  const arms: FrozenArms = { challenger: [], current: [], random: [] };
  for (const arm of ARMS) {
    const values = parsed[arm];
    if (!Array.isArray(values) || values.length !== row.ticket_count)
      throw new Error("Unequal shadow arm size");
    arms[arm] = values.map((value) => {
      if (
        !record(value) ||
        !Array.isArray(value.main) ||
        !Array.isArray(value.bonus) ||
        !value.main.every((n) => Number.isSafeInteger(n)) ||
        !value.bonus.every((n) => Number.isSafeInteger(n)) ||
        value.game !== row.game ||
        value.playStyle !== "straight" ||
        value.wagerCents !== row.wager_cents ||
        !record(value.options)
      ) {
        throw new Error("Invalid immutable shadow ticket");
      }
      const ticket: FrozenTicket = {
        game: row.game,
        main: value.main,
        bonus: value.bonus,
        playStyle: "straight",
        wagerCents: row.wager_cents,
        options: value.options
      };
      validateTicket(row.game, ticket);
      return ticket;
    });
  }
  for (let i = 0; i < row.ticket_count; i += 1) {
    if (
      ARMS.some(
        (arm) => JSON.stringify(arms[arm][i]?.options) !== JSON.stringify(arms.current[i]?.options)
      )
    ) {
      throw new Error("Shadow arms must share the same frozen ordinal ticket options");
    }
  }
  return arms;
}

/** Persist eligible trials only while the actual server clock is pre-cutoff. */
export async function captureShadowTrials(
  env: Env,
  runId: string,
  executionNow: () => Date = () => new Date()
): Promise<number> {
  const parent = await env.LOTTO_DB.prepare(
    `SELECT l.*, b.ledger_id AS baseline_id,
       CASE WHEN e.reason_code='schema-v7-attestation' THEN 0 ELSE e.eligible END AS eligible,
       CASE WHEN be.reason_code='schema-v7-attestation' THEN 0 ELSE be.eligible END AS baseline_eligible
     FROM lotto_ticket_ledger l JOIN lotto_ticket_ledger b ON b.baseline_for = l.ledger_id
       AND b.game=l.game AND b.draw_date=l.draw_date AND b.target_session=l.target_session
       AND b.ticket_count=l.ticket_count AND b.ticket_cost_cents=l.ticket_cost_cents
     JOIN lotto_ledger_eligibility_events e ON e.event_sequence =
       (SELECT MAX(event_sequence) FROM lotto_ledger_eligibility_events WHERE ledger_id = l.ledger_id)
     JOIN lotto_ledger_eligibility_events be ON be.event_sequence =
       (SELECT MAX(event_sequence) FROM lotto_ledger_eligibility_events WHERE ledger_id = b.ledger_id)
     WHERE l.run_id = ?1 AND l.origin = 'system' AND b.origin = 'random'`
  )
    .bind(runId)
    .first<ParentRow>();
  if (!parent || !parent.eligible || !parent.baseline_eligible) return 0;
  const start = executionNow();
  if (
    parent.draw_date >= REVIEW_DATE ||
    !ticketSalesWindow(parent.game, parent.draw_date, parent.target_session, start).beforeCutoff
  )
    return 0;
  if (
    !parent.seed ||
    !parent.dataset_digest ||
    !parent.observed_through ||
    parent.observed_through >= parent.draw_date ||
    parent.proposed_at > start.toISOString()
  ) {
    throw new Error("Shadow trial lacks valid pre-draw provenance");
  }
  if (parent.ticket_count > 64)
    throw new Error("Shadow protocol capped at 64 equal-cost tickets; live picks unchanged");
  if (
    await env.LOTTO_DB.prepare(
      `SELECT 1 FROM lotto_draws WHERE game=?1 AND draw_date=?2 AND session=?3 LIMIT 1`
    )
      .bind(parent.game, parent.draw_date, parent.target_session)
      .first()
  )
    return 0;
  const stored = await env.LOTTO_DB.prepare(
    `SELECT * FROM lotto_ledger_tickets WHERE ledger_id IN (?1,?2) ORDER BY ordinal`
  )
    .bind(parent.ledger_id, parent.baseline_id)
    .all<StoredTicket>();
  const current = stored.results
    .filter((r) => r.ledger_id === parent.ledger_id)
    .map((r) => freezeTicket(parent.game, r));
  const baseline = stored.results
    .filter((r) => r.ledger_id === parent.baseline_id)
    .map((r) => freezeTicket(parent.game, r));
  if (
    current.length !== parent.ticket_count ||
    baseline.length !== current.length ||
    current.some((t) => t.wagerCents !== parent.ticket_cost_cents)
  )
    throw new Error("Shadow parent/control exposure mismatch");
  // Common ordinal multipliers isolate number selection from a randomly assigned MM multiplier.
  const random = baseline.map((t, i) => ({ ...t, options: (current[i] as FrozenTicket).options }));
  let created = 0;
  for (const variantId of variantsFor(parent.game)) {
    const trialId = `shadow-${(await hash(`${PROTOCOL}\0${parent.ledger_id}\0${variantId}`)).slice(0, 32)}`;
    if (
      await env.LOTTO_DB.prepare(`SELECT 1 FROM lotto_shadow_trials WHERE trial_id=?1`)
        .bind(trialId)
        .first()
    )
      continue;
    const seed = await hash(`${PROTOCOL}\0${variantId}\0${parent.seed}`);
    const config = {
      protocol: PROTOCOL,
      reviewDate: REVIEW_DATE,
      variantId,
      version: "1",
      game: parent.game,
      count: parent.ticket_count,
      playStyle: "straight",
      wagerCents: parent.ticket_cost_cents,
      objective: "any-prize",
      optimizationDraws: 512,
      evaluationDraws: 4096,
      candidatePoolSize: 64,
      currentOptimizerVersion: "pair-coverage-v1",
      multiplierPolicy: "common-ordinal-frozen-paper-options"
    };
    const configJson = JSON.stringify(config);
    const configHash = await hash(configJson);
    const candidate = generateChallenger({
      game: parent.game,
      count: parent.ticket_count,
      seed,
      playStyle: "straight",
      challengerId: variantId,
      objective: "any-prize",
      optimizationDraws: config.optimizationDraws,
      evaluationDraws: config.evaluationDraws,
      candidatePoolSize: config.candidatePoolSize
    });
    const challenger = candidate.tickets.map((t, i) => ({
      ...t,
      bonus: t.bonus ?? [],
      playStyle: "straight" as const,
      wagerCents: parent.ticket_cost_cents,
      options: (current[i] as FrozenTicket).options
    }));
    if (challenger.length !== current.length) throw new Error("Challenger changed ticket count");
    const committedAt = executionNow();
    if (
      !ticketSalesWindow(parent.game, parent.draw_date, parent.target_session, committedAt)
        .beforeCutoff
    )
      return created;
    const inserted = await env.LOTTO_DB.prepare(
      `INSERT OR IGNORE INTO lotto_shadow_trials
       (trial_id,parent_ledger_id,baseline_ledger_id,variant_id,optimizer_version,protocol_version,
        game,draw_date,target_session,proposed_at,seed,objective,config_hash,config_json,
        observed_through,dataset_digest,ticket_count,wager_cents,arms_json,metrics_json)
       SELECT ?1,?2,?3,?4,'1',?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19
       WHERE NOT EXISTS (SELECT 1 FROM lotto_draws WHERE game=?6 AND draw_date=?7 AND session=?8)
         AND (SELECT eligible FROM lotto_ledger_eligibility_events WHERE ledger_id=?2 ORDER BY event_sequence DESC LIMIT 1)=1
         AND (SELECT eligible FROM lotto_ledger_eligibility_events WHERE ledger_id=?3 ORDER BY event_sequence DESC LIMIT 1)=1`
    )
      .bind(
        trialId,
        parent.ledger_id,
        parent.baseline_id,
        variantId,
        PROTOCOL,
        parent.game,
        parent.draw_date,
        parent.target_session,
        committedAt.toISOString(),
        seed,
        candidate.objective,
        configHash,
        configJson,
        parent.observed_through,
        parent.dataset_digest,
        parent.ticket_count,
        parent.ticket_cost_cents,
        JSON.stringify({ challenger, current, random }),
        JSON.stringify({ metrics: candidate.metrics, notes: candidate.notes })
      )
      .run();
    created += Number(inserted.meta.changes ?? 0);
  }
  return created;
}

interface GradeCandidate extends TrialRow {
  result_main: string | null;
  result_bonus: string | null;
  result_metadata: string | null;
  result_fingerprint: string | null;
  result_first_seen_at: string | null;
  result_source_sha256: string | null;
  eligible: number;
  eligibility_id: string;
  baseline_eligible: number;
  baseline_eligibility_id: string;
  previous_grade_id: string | null;
  previous_outcome_hash: string | null;
}

/** Append grade revisions; old trials/grades remain intact and no SMS is emitted. */
export async function gradeShadowTrials(
  env: Env,
  game: GameCode | null = null,
  now = new Date()
): Promise<number> {
  const retryBefore = new Date(now.getTime() - 30 * 60_000).toISOString();
  const candidates = await env.LOTTO_DB.prepare(
    `SELECT t.*, d.ordered_numbers AS result_main,d.bonus_numbers AS result_bonus,d.metadata AS result_metadata,
      d.content_fingerprint AS result_fingerprint,d.first_seen_at AS result_first_seen_at,d.source_sha256 AS result_source_sha256,
      CASE WHEN e.reason_code='schema-v7-attestation' THEN 0 ELSE e.eligible END AS eligible,e.eligibility_event_id AS eligibility_id,
      CASE WHEN be.reason_code='schema-v7-attestation' THEN 0 ELSE be.eligible END AS baseline_eligible,be.eligibility_event_id AS baseline_eligibility_id,
      g.grade_id AS previous_grade_id,g.outcome_hash AS previous_outcome_hash
     FROM lotto_shadow_trials t
     JOIN lotto_ledger_eligibility_events e ON e.event_sequence=(SELECT MAX(event_sequence) FROM lotto_ledger_eligibility_events WHERE ledger_id=t.parent_ledger_id)
     JOIN lotto_ledger_eligibility_events be ON be.event_sequence=(SELECT MAX(event_sequence) FROM lotto_ledger_eligibility_events WHERE ledger_id=t.baseline_ledger_id)
     LEFT JOIN lotto_draws d ON d.game=t.game AND d.draw_date=t.draw_date AND d.session=t.target_session AND d.active=1
     LEFT JOIN lotto_shadow_grades g ON g.event_sequence=(SELECT MAX(event_sequence) FROM lotto_shadow_grades WHERE trial_id=t.trial_id)
     LEFT JOIN lotto_shadow_work w ON w.trial_id=t.trial_id
     LEFT JOIN lotto_payout_sources p ON p.game=t.game AND p.draw_date=t.draw_date
     WHERE (?1 IS NULL OR t.game=?1) AND (w.next_attempt_at IS NULL OR w.next_attempt_at<=?3) AND (
       (g.grade_id IS NULL AND d.content_fingerprint IS NOT NULL) OR
       (g.grade_id IS NOT NULL AND (g.draw_fingerprint IS NOT d.content_fingerprint
        OR json_extract(g.evidence_json,'$.eligibilityId') IS NOT e.eligibility_event_id
        OR json_extract(g.evidence_json,'$.baselineEligibilityId') IS NOT be.eligibility_event_id
        OR (g.status='pending' AND g.graded_at < ?2))))
     ORDER BY CASE WHEN g.status='pending' AND g.draw_fingerprint=d.content_fingerprint THEN 1 ELSE 0 END,
       CASE WHEN g.status='pending' THEN COALESCE(p.last_attempt_at,'') ELSE '' END,
       COALESCE(w.last_attempt_at,''),t.draw_date,t.trial_id LIMIT 32`
  )
    .bind(game, retryBefore, now.toISOString())
    .all<GradeCandidate>();
  let created = 0;
  let payoutFetches = 0;
  const attemptedPayoutDraws = new Set<string>();
  for (const row of candidates.results) {
    const claimed = await env.LOTTO_DB.prepare(
      `INSERT INTO lotto_shadow_work(trial_id,last_attempt_at,next_attempt_at,last_error) VALUES(?1,?2,?3,NULL)
       ON CONFLICT(trial_id) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,next_attempt_at=excluded.next_attempt_at,last_error=NULL
       WHERE lotto_shadow_work.next_attempt_at<=?2`
    )
      .bind(row.trial_id, now.toISOString(), new Date(now.getTime() + 120_000).toISOString())
      .run();
    if (Number(claimed.meta.changes ?? 0) !== 1) continue;
    let failure: string | null = null;
    try {
      let reason: string | null = null;
      if (!row.eligible || !row.baseline_eligible)
        reason = "Parent/control ledger excluded from forward evidence";
      else if (!row.result_fingerprint) reason = "Official result unavailable or withdrawn";
      else if (!row.result_first_seen_at || row.result_first_seen_at <= row.proposed_at)
        reason = "Official result not after trial capture";
      else if (
        !ticketSalesWindow(row.game, row.draw_date, row.target_session, new Date(row.proposed_at))
          .beforeCutoff
      )
        reason = "Trial not captured before sales cutoff";
      let outcomes: GradedArms | null = null;
      let payout: Record<string, unknown> | null = null;
      if (reason === null && row.result_main && row.result_bonus && row.result_metadata) {
        const arms = parseArms(row);
        const result = {
          drawDate: row.draw_date,
          main: numbers(row.result_main),
          bonus: numbers(row.result_bonus),
          metadata: objectJson(row.result_metadata)
        };
        payout = await readOfficialPayoutMetadata(
          env,
          row.game,
          row.draw_date,
          result.main,
          result.bonus
        );
        const score = (): GradedArms => {
          const output = {} as GradedArms;
          for (const arm of ARMS) {
            const tickets = arms[arm].map((t) =>
              gradeTicket(row.game, t, { ...result, metadata: { ...result.metadata, ...payout } })
            );
            output[arm] = {
              tickets,
              cashCents: tickets.reduce((s, t) => s + (t.prizeCents ?? 0), 0),
              nonCashValueCents: tickets.reduce(
                (s, t) =>
                  s + (typeof t.detail.faceValueCents === "number" ? t.detail.faceValueCents : 0),
                0
              ),
              pendingPrizeCount: tickets.filter((t) => t.payoutStatus === "pending").length,
              hits: tickets.filter((t) => t.hit).length
            };
          }
          return output;
        };
        outcomes = score();
        const lowerTierPending = ARMS.some((arm) =>
          outcomes?.[arm].tickets.some(
            (t) =>
              t.payoutStatus === "pending" &&
              ((row.game === "lotto" && t.mainMatches < 6) ||
                (row.game === "twostep" && !(t.mainMatches === 4 && t.bonusMatches === 1)))
          )
        );
        const payoutKey = `${row.game}/${row.draw_date}`;
        const payoutState = lowerTierPending
          ? await env.LOTTO_DB.prepare(
              "SELECT next_attempt_at FROM lotto_payout_sources WHERE game=?1 AND draw_date=?2"
            )
              .bind(row.game, row.draw_date)
              .first<{ next_attempt_at: string | null }>()
          : null;
        const payoutDue =
          !payoutState?.next_attempt_at || payoutState.next_attempt_at <= now.toISOString();
        if (
          !payout &&
          lowerTierPending &&
          payoutFetches < 2 &&
          payoutDue &&
          !attemptedPayoutDraws.has(payoutKey)
        ) {
          payoutFetches += 1;
          attemptedPayoutDraws.add(payoutKey);
          try {
            payout = await ensureOfficialPayoutMetadata(
              env,
              row.game,
              row.draw_date,
              result.main,
              result.bonus,
              now
            );
          } catch (error) {
            console.error(
              JSON.stringify({
                service: "rabbitholetx",
                event: "shadow_payout_pending",
                trialId: row.trial_id,
                error: String(error).slice(0, 500)
              })
            );
          }
          if (payout) outcomes = score();
        }
      }
      const status = reason
        ? "excluded"
        : ARMS.some((arm) => (outcomes?.[arm].pendingPrizeCount ?? 0) > 0)
          ? "pending"
          : "graded";
      const evidence = {
        eligibilityId: row.eligibility_id,
        baselineEligibilityId: row.baseline_eligibility_id,
        drawFingerprint: row.result_fingerprint,
        sourceSha256: row.result_source_sha256,
        payout,
        ruleVersion: 1,
        reason
      };
      const evidenceJson = JSON.stringify(evidence);
      const armsJson = JSON.stringify(outcomes ?? {});
      const outcomeHash = await hash(JSON.stringify({ status, evidence, outcomes }));
      if (outcomeHash === row.previous_outcome_hash) continue;
      const gradeId = `sg-${(await hash(`${row.trial_id}\0${row.previous_grade_id ?? ""}\0${outcomeHash}`)).slice(0, 32)}`;
      const result = await env.LOTTO_DB.prepare(
        `INSERT OR IGNORE INTO lotto_shadow_grades
       (grade_id,trial_id,previous_grade_id,outcome_hash,draw_fingerprint,status,reason,evidence_json,arms_json,graded_at)
       SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10 WHERE COALESCE(
         (SELECT grade_id FROM lotto_shadow_grades WHERE trial_id=?2 ORDER BY event_sequence DESC LIMIT 1),'')=COALESCE(?3,'')
       AND (SELECT eligibility_event_id FROM lotto_ledger_eligibility_events WHERE ledger_id=?11 ORDER BY event_sequence DESC LIMIT 1)=?12
       AND (SELECT eligibility_event_id FROM lotto_ledger_eligibility_events WHERE ledger_id=?13 ORDER BY event_sequence DESC LIMIT 1)=?14
       AND (SELECT content_fingerprint FROM lotto_draws WHERE game=?15 AND draw_date=?16 AND session=?17 AND active=1) IS ?5`
      )
        .bind(
          gradeId,
          row.trial_id,
          row.previous_grade_id,
          outcomeHash,
          row.result_fingerprint,
          status,
          reason,
          evidenceJson,
          armsJson,
          now.toISOString(),
          row.parent_ledger_id,
          row.eligibility_id,
          row.baseline_ledger_id,
          row.baseline_eligibility_id,
          row.game,
          row.draw_date,
          row.target_session
        )
        .run();
      created += Number(result.meta.changes ?? 0);
    } catch (error) {
      failure = String(error).slice(0, 1000);
      console.error(
        JSON.stringify({
          service: "rabbitholetx",
          event: "shadow_grade_failed",
          trialId: row.trial_id,
          error: failure
        })
      );
    } finally {
      await env.LOTTO_DB.prepare(
        `UPDATE lotto_shadow_work SET next_attempt_at=?2,last_error=?3 WHERE trial_id=?1 AND last_attempt_at=?4`
      )
        .bind(
          row.trial_id,
          new Date(now.getTime() + 30 * 60_000).toISOString(),
          failure,
          now.toISOString()
        )
        .run();
    }
  }
  return created;
}

/** Retry only today's pre-cutoff captures; never manufacture historical trials. */
export async function recoverShadowTrials(env: Env, now = new Date()): Promise<number> {
  const date = texasClock(now).date;
  const runs = await env.LOTTO_DB.prepare(
    `SELECT r.run_id FROM lotto_generation_runs r JOIN lotto_game_config c ON c.game=r.game
     WHERE r.status='generated' AND r.draw_date=?1 AND c.selected=1 ORDER BY r.game LIMIT 8`
  )
    .bind(date)
    .all<{ run_id: string }>();
  let created = 0;
  for (const run of runs.results) {
    try {
      created += await captureShadowTrials(env, run.run_id);
    } catch (error) {
      console.error(
        JSON.stringify({
          service: "rabbitholetx",
          event: "shadow_recovery_failed",
          runId: run.run_id,
          error: String(error).slice(0, 500)
        })
      );
    }
  }
  return created;
}

interface PublicRow extends TrialRow {
  grade_status: "graded" | "pending" | "excluded" | null;
  grade_arms: string | null;
}
interface Scorecard {
  gradedDraws: number;
  gradedTickets: number;
  spentCents: number;
  wonCents: number;
  nonCashValueCents: number;
  pendingPrizeCount: number;
  roiPercent: number | null;
}

function scorecard(rows: readonly PublicRow[], arm: Arm): Scorecard {
  const result: Scorecard = {
    gradedDraws: 0,
    gradedTickets: 0,
    spentCents: 0,
    wonCents: 0,
    nonCashValueCents: 0,
    pendingPrizeCount: 0,
    roiPercent: null
  };
  for (const row of rows) {
    if (!row.grade_arms || row.grade_status === "excluded" || !row.grade_status) continue;
    const parsed = objectJson(row.grade_arms)[arm];
    if (
      !record(parsed) ||
      ![parsed.cashCents, parsed.nonCashValueCents, parsed.pendingPrizeCount].every(
        (v) => Number.isSafeInteger(v) && Number(v) >= 0
      )
    )
      throw new Error("Invalid shadow grade summary");
    result.gradedDraws += 1;
    result.gradedTickets += row.ticket_count;
    result.spentCents += row.ticket_count * row.wager_cents;
    result.wonCents += Number(parsed.cashCents);
    result.nonCashValueCents += Number(parsed.nonCashValueCents);
    result.pendingPrizeCount += Number(parsed.pendingPrizeCount);
  }
  if (result.spentCents && !result.pendingPrizeCount)
    result.roiPercent =
      Math.round(((result.wonCents - result.spentCents) * 10000) / result.spentCents) / 100;
  return result;
}

/** Private bounded comparison: all three arms use precisely the same trial rows. */
export async function readShadowTrials(env: Env, filters: TicketLabFilters) {
  const clauses = ["1=1"];
  const values: string[] = [];
  for (const [column, value, operator] of [
    ["t.game", filters.game, "="],
    ["t.draw_date", filters.from, ">="],
    ["t.draw_date", filters.to, "<="]
  ] as const) {
    if (value !== null) {
      values.push(value);
      clauses.push(`${column}${operator}?${values.length}`);
    }
  }
  const statement = env.LOTTO_DB.prepare(
    `SELECT t.*,
       CASE WHEN COALESCE(e.eligible,0)<>1 OR COALESCE(be.eligible,0)<>1
            OR e.reason_code='schema-v7-attestation' OR be.reason_code='schema-v7-attestation' THEN 'excluded'
            WHEN g.draw_fingerprint IS NOT d.content_fingerprint THEN NULL ELSE g.status END AS grade_status,
       g.arms_json AS grade_arms FROM lotto_shadow_trials t
     LEFT JOIN lotto_ledger_eligibility_events e ON e.event_sequence=(SELECT MAX(event_sequence) FROM lotto_ledger_eligibility_events WHERE ledger_id=t.parent_ledger_id)
     LEFT JOIN lotto_ledger_eligibility_events be ON be.event_sequence=(SELECT MAX(event_sequence) FROM lotto_ledger_eligibility_events WHERE ledger_id=t.baseline_ledger_id)
     LEFT JOIN lotto_draws d ON d.game=t.game AND d.draw_date=t.draw_date AND d.session=t.target_session AND d.active=1
     LEFT JOIN lotto_shadow_grades g ON g.event_sequence=(SELECT MAX(event_sequence) FROM lotto_shadow_grades WHERE trial_id=t.trial_id)
     WHERE ${clauses.join(" AND ")} ORDER BY t.draw_date DESC,t.trial_id LIMIT 5001`
  );
  const rows = (await (values.length ? statement.bind(...values) : statement).all<PublicRow>())
    .results;
  if (rows.length > 5000)
    throw new RangeError("Narrow the date range to at most 5000 shadow trials");
  return {
    policy: {
      paperOnly: true,
      forwardOnly: true,
      autoPromotion: false,
      matching: ["game", "drawDate", "targetSession", "ticketCount", "wagerCents", "playStyle"],
      reviewDate: REVIEW_DATE,
      description:
        "All arms use identical pre-draw exposure and common ordinal paper ticket options. Excluded trials never enter comparisons. Review date is not a significance guarantee; no automatic promotion."
    },
    variants: VARIANTS.map((variant) => {
      const selected = rows.filter(
        (r) => r.variant_id === variant.id && r.grade_status !== "excluded"
      );
      return {
        ...variant,
        frozenAt: selected.map((r) => r.proposed_at).sort()[0] ?? null,
        firstEligibleDrawDate: selected.map((r) => r.draw_date).sort()[0] ?? null,
        draws: selected.length,
        tickets: selected.reduce((s, r) => s + r.ticket_count, 0),
        ...scorecard(selected, "challenger"),
        status: selected.length ? ("collecting" as const) : ("armed" as const),
        comparisons: {
          current: scorecard(selected, "current"),
          random: scorecard(selected, "random")
        }
      };
    }),
    latest: rows.slice(0, 20).map((r) => ({
      trialId: r.trial_id,
      variantId: r.variant_id,
      game: r.game,
      drawDate: r.draw_date,
      targetSession: r.target_session,
      proposedAt: r.proposed_at,
      seed: r.seed,
      configHash: r.config_hash,
      observedThrough: r.observed_through,
      status: r.grade_status ?? "open",
      tickets: parseArms(r).challenger.map((t) => ({
        game: t.game,
        main: t.main,
        bonus: t.bonus,
        playStyle: t.playStyle
      }))
    })),
    disclaimer: SHADOW_DISCLAIMER
  };
}
