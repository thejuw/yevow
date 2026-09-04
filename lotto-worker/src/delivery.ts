import type { Env } from "./env";
import type { GameCode } from "./manifest";
import { refreshDailySummary } from "./autonomy";

// Covers the maximum configured bridge path: four 45-second primary attempts,
// exponential backoff, four fallback-alert attempts, and API acknowledgement.
const DELIVERY_LEASE_MILLISECONDS = 30 * 60_000;
const DELIVERY_DEAD_ATTEMPTS = 12;

interface TimingSafeSubtleCrypto extends SubtleCrypto {
  timingSafeEqual(left: ArrayBuffer, right: ArrayBuffer): boolean;
}

interface DeliveryRow {
  delivery_id: string;
  run_id: string;
  delivery_kind: "picks" | "alert";
  target_role: "primary" | "fallback";
  message_body: string;
  status: "pending" | "leased" | "retry" | "sent" | "ambiguous" | "dead";
  attempt_count: number;
  next_attempt_at: string;
  lease_token: string | null;
  lease_expires_at: string | null;
  external_id: string | null;
  last_error: string | null;
  alert_status: string | null;
  alert_external_id: string | null;
  alert_error: string | null;
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
  game: GameCode;
  draw_date: string;
}

interface LabDeliveryRow {
  delivery_id: string;
  grade_id: string | null;
  run_id: string;
  delivery_kind: "result" | "alert";
  target_role: "primary" | "fallback";
  priority: number;
  message_body: string;
  status: "pending" | "leased" | "retry" | "sent" | "ambiguous" | "dead";
  attempt_count: number;
  next_attempt_at: string;
  lease_token: string | null;
  lease_expires_at: string | null;
  external_id: string | null;
  last_error: string | null;
  alert_status: string | null;
  alert_external_id: string | null;
  alert_error: string | null;
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
  game: GameCode;
  draw_date: string;
}

export interface DeliveryClaim {
  readonly deliveryId: string;
  readonly leaseToken: string;
  readonly runId: string;
  readonly kind: "picks" | "alert" | "result";
  readonly targetRole: "primary" | "fallback";
  readonly game: GameCode;
  readonly drawDate: string;
  readonly message: string;
  readonly priorAttempts: number;
  readonly leaseExpiresAt: string;
}

export interface DeliveryResultInput {
  readonly leaseToken: string;
  readonly status: "sent" | "failed" | "ambiguous";
  readonly attempts: number;
  readonly externalId?: string;
  readonly error?: string;
  readonly alertStatus?: string;
  readonly alertExternalId?: string;
  readonly alertError?: string;
}

export interface DeliveryResult {
  readonly deliveryId: string;
  readonly status: "retry" | "sent" | "ambiguous" | "dead";
  readonly attempts: number;
  readonly nextAttemptAt: string | null;
  readonly deliveredAt: string | null;
}

function bounded(value: string | undefined, maximum: number): string | null {
  if (value === undefined) return null;
  const cleaned = value.trim();
  return cleaned ? cleaned.slice(0, maximum) : null;
}

async function secretEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right))
  ]);
  return (crypto.subtle as TimingSafeSubtleCrypto).timingSafeEqual(leftDigest, rightDigest);
}

export async function serviceAuthorized(request: Request, env: Env): Promise<boolean> {
  const expected = env.RABBITHOLETX_SERVICE_TOKEN?.trim();
  if (!expected) return false;
  const header = request.headers.get("Authorization") ?? "";
  const match = header.match(/^Bearer ([^\s]+)$/);
  return match ? secretEqual(match[1] as string, expected) : false;
}

function publicClaim(row: DeliveryRow, leaseToken: string, leaseExpiresAt: string): DeliveryClaim {
  return {
    deliveryId: row.delivery_id,
    leaseToken,
    runId: row.run_id,
    kind: row.delivery_kind,
    targetRole: row.target_role,
    game: row.game,
    drawDate: row.draw_date,
    message: row.message_body,
    priorAttempts: row.attempt_count,
    leaseExpiresAt
  };
}

async function claimLabDelivery(
  env: Env,
  now: Date,
  tier: "high" | "low"
): Promise<DeliveryClaim | null> {
  const nowIso = now.toISOString();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidate = await env.LOTTO_DB.prepare(
      `SELECT o.*
       FROM lotto_lab_delivery_outbox o
       WHERE (
          o.status IN ('pending', 'retry')
          OR (o.status = 'leased' AND o.lease_expires_at <= ?1)
       ) AND o.next_attempt_at <= ?1
         AND ${tier === "high" ? "o.priority >= 50" : "o.priority < 50"}
       ORDER BY o.priority DESC, o.created_at, o.delivery_id LIMIT 1`
    )
      .bind(nowIso)
      .first<LabDeliveryRow>();
    if (!candidate) return null;
    const leaseToken = crypto.randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + DELIVERY_LEASE_MILLISECONDS).toISOString();
    const claimed = await env.LOTTO_DB.prepare(
      `UPDATE lotto_lab_delivery_outbox
       SET status = 'leased', lease_token = ?1, lease_expires_at = ?2, updated_at = ?3
       WHERE delivery_id = ?4
         AND (status IN ('pending', 'retry')
              OR (status = 'leased' AND lease_expires_at <= ?3))
         AND next_attempt_at <= ?3`
    )
      .bind(leaseToken, leaseExpiresAt, nowIso, candidate.delivery_id)
      .run();
    if ((claimed.meta.changes ?? 0) === 1) {
      return {
        deliveryId: candidate.delivery_id,
        leaseToken,
        runId: candidate.run_id,
        kind: candidate.delivery_kind,
        targetRole: candidate.target_role,
        game: candidate.game,
        drawDate: candidate.draw_date,
        message: candidate.message_body,
        priorAttempts: candidate.attempt_count,
        leaseExpiresAt
      };
    }
  }
  return null;
}

export async function claimDelivery(env: Env, now = new Date()): Promise<DeliveryClaim | null> {
  const nowIso = now.toISOString();
  const urgentLab = await claimLabDelivery(env, now, "high");
  if (urgentLab) return urgentLab;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidate = await env.LOTTO_DB.prepare(
      `SELECT o.*, r.game, r.draw_date
       FROM lotto_delivery_outbox o
       JOIN lotto_generation_runs r ON r.run_id = o.run_id
       WHERE (
          o.status IN ('pending', 'retry')
          OR (o.status = 'leased' AND o.lease_expires_at <= ?1)
       )
         AND o.next_attempt_at <= ?1
       ORDER BY CASE o.delivery_kind WHEN 'alert' THEN 0 ELSE 1 END,
                o.created_at, o.delivery_id
       LIMIT 1`
    )
      .bind(nowIso)
      .first<DeliveryRow>();
    if (!candidate) break;
    const leaseToken = crypto.randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + DELIVERY_LEASE_MILLISECONDS).toISOString();
    const claimed = await env.LOTTO_DB.prepare(
      `UPDATE lotto_delivery_outbox
       SET status = 'leased', lease_token = ?1, lease_expires_at = ?2, updated_at = ?3
       WHERE delivery_id = ?4
         AND (
           status IN ('pending', 'retry')
           OR (status = 'leased' AND lease_expires_at <= ?3)
         )
         AND next_attempt_at <= ?3`
    )
      .bind(leaseToken, leaseExpiresAt, nowIso, candidate.delivery_id)
      .run();
    if ((claimed.meta.changes ?? 0) === 1) {
      return publicClaim(candidate, leaseToken, leaseExpiresAt);
    }
  }
  return claimLabDelivery(env, now, "low");
}

export function parseDeliveryResult(value: unknown): DeliveryResultInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RangeError("delivery result must be an object");
  }
  const record = value as Record<string, unknown>;
  const leaseToken = record.leaseToken;
  const status = record.status;
  const attempts = record.attempts;
  if (typeof leaseToken !== "string" || !/^[0-9a-f-]{36}$/i.test(leaseToken)) {
    throw new RangeError("leaseToken is malformed");
  }
  if (status !== "sent" && status !== "failed" && status !== "ambiguous") {
    throw new RangeError("status must be sent, failed, or ambiguous");
  }
  if (!Number.isSafeInteger(attempts) || (attempts as number) < 0 || (attempts as number) > 4) {
    throw new RangeError("attempts must be an integer from 0 through 4");
  }
  const optional = (key: string): string | undefined => {
    const item = record[key];
    if (item === undefined || item === null) return undefined;
    if (typeof item !== "string") throw new RangeError(`${key} must be a string`);
    return item;
  };
  const externalId = optional("externalId");
  const error = optional("error");
  const alertStatus = optional("alertStatus");
  const alertExternalId = optional("alertExternalId");
  const alertError = optional("alertError");
  if (status === "sent" && !externalId?.trim()) {
    throw new RangeError("externalId is required when status is sent");
  }
  if (alertStatus !== undefined && !["sent", "failed", "ambiguous"].includes(alertStatus)) {
    throw new RangeError("alertStatus must be sent, failed, or ambiguous");
  }
  if (alertStatus === "sent" && !alertExternalId?.trim()) {
    throw new RangeError("alertExternalId is required when alertStatus is sent");
  }
  if (alertExternalId !== undefined && alertStatus !== "sent") {
    throw new RangeError("alertExternalId applies only to a sent alert");
  }
  return {
    leaseToken,
    status,
    attempts: attempts as number,
    ...(externalId ? { externalId } : {}),
    ...(error ? { error } : {}),
    ...(alertStatus ? { alertStatus } : {}),
    ...(alertExternalId ? { alertExternalId } : {}),
    ...(alertError ? { alertError } : {})
  };
}

export async function completeDelivery(
  env: Env,
  deliveryId: string,
  input: DeliveryResultInput,
  now = new Date()
): Promise<DeliveryResult | null> {
  if (/^(?:result-grade|lab-alert)-[a-f0-9]{32}$/.test(deliveryId)) {
    return completeLabDelivery(env, deliveryId, input, now);
  }
  if (!/^(?:delivery|alert)-gen-[a-f0-9]{32}$/.test(deliveryId)) {
    throw new RangeError("delivery id is malformed");
  }
  if (input.status === "sent" && !input.externalId?.trim()) {
    throw new RangeError("externalId is required when status is sent");
  }
  if (
    input.alertStatus !== undefined &&
    !["sent", "failed", "ambiguous"].includes(input.alertStatus)
  ) {
    throw new RangeError("alertStatus must be sent, failed, or ambiguous");
  }
  if (input.alertStatus === "sent" && !input.alertExternalId?.trim()) {
    throw new RangeError("alertExternalId is required when alertStatus is sent");
  }
  if (input.alertExternalId !== undefined && input.alertStatus !== "sent") {
    throw new RangeError("alertExternalId applies only to a sent alert");
  }
  const row = await env.LOTTO_DB.prepare(
    `SELECT o.*, r.game, r.draw_date
     FROM lotto_delivery_outbox o JOIN lotto_generation_runs r ON r.run_id = o.run_id
     WHERE o.delivery_id = ?1`
  )
    .bind(deliveryId)
    .first<DeliveryRow>();
  if (!row) return null;
  if (row.status === "sent") {
    return {
      deliveryId,
      status: "sent",
      attempts: row.attempt_count,
      nextAttemptAt: null,
      deliveredAt: row.delivered_at
    };
  }
  if (row.status !== "leased" || row.lease_token !== input.leaseToken) {
    throw new Error("delivery lease does not match the active claim");
  }
  const completedAt = now.toISOString();
  const attemptCount = row.attempt_count + input.attempts;
  const status: DeliveryResult["status"] =
    input.status === "sent"
      ? "sent"
      : input.status === "ambiguous"
        ? "ambiguous"
        : input.attempts === 0
          ? "dead"
          : attemptCount >= DELIVERY_DEAD_ATTEMPTS
            ? "dead"
            : "retry";
  const nextAttemptAt =
    status === "retry" ? new Date(now.getTime() + 30 * 60_000).toISOString() : null;
  const deliveredAt = status === "sent" ? completedAt : null;
  const externalId = bounded(input.externalId, 500);
  const error = bounded(input.error, 2_000);
  const alertStatus = bounded(input.alertStatus, 100);
  const alertExternalId = bounded(input.alertExternalId, 500);
  const alertError = bounded(input.alertError, 2_000);
  const transitions = await env.LOTTO_DB.batch([
    env.LOTTO_DB.prepare(
      `INSERT INTO lotto_delivery_attempts
         (delivery_id, lease_token, started_at, completed_at, local_attempts, result,
          external_id, error, alert_status, alert_external_id, alert_error)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11
       WHERE EXISTS (
         SELECT 1 FROM lotto_delivery_outbox
         WHERE delivery_id = ?1 AND status = 'leased' AND lease_token = ?2
       )`
    ).bind(
      deliveryId,
      input.leaseToken,
      row.updated_at,
      completedAt,
      input.attempts,
      input.status,
      externalId,
      error,
      alertStatus,
      alertExternalId,
      alertError
    ),
    env.LOTTO_DB.prepare(
      `UPDATE lotto_delivery_outbox
       SET status = ?1, attempt_count = ?2, next_attempt_at = COALESCE(?3, next_attempt_at),
           lease_token = NULL, lease_expires_at = NULL, external_id = COALESCE(?4, external_id),
           last_error = ?5, alert_status = ?6, alert_external_id = ?7, alert_error = ?8,
           delivered_at = ?9, updated_at = ?10
       WHERE delivery_id = ?11 AND status = 'leased' AND lease_token = ?12`
    ).bind(
      status,
      attemptCount,
      nextAttemptAt,
      externalId,
      error,
      alertStatus,
      alertExternalId,
      alertError,
      deliveredAt,
      completedAt,
      deliveryId,
      input.leaseToken
    )
  ]);
  if ((transitions[0]?.meta.changes ?? 0) !== 1 || (transitions[1]?.meta.changes ?? 0) !== 1) {
    throw new Error("delivery lease was lost before the result could be committed");
  }
  const dueCount = await env.LOTTO_DB.prepare(
    `SELECT due_games FROM lotto_daily_summaries WHERE service_date = ?1`
  )
    .bind(row.draw_date)
    .first<{ due_games: number }>();
  await refreshDailySummary(env, row.draw_date, Number(dueCount?.due_games ?? 0), 0, completedAt);
  console.log(
    JSON.stringify({
      service: "rabbitholetx",
      event: "delivery_result",
      deliveryId,
      game: row.game,
      drawDate: row.draw_date,
      status,
      attempts: attemptCount,
      alertStatus
    })
  );
  return { deliveryId, status, attempts: attemptCount, nextAttemptAt, deliveredAt };
}

async function completeLabDelivery(
  env: Env,
  deliveryId: string,
  input: DeliveryResultInput,
  now: Date
): Promise<DeliveryResult | null> {
  const row = await env.LOTTO_DB.prepare(
    `SELECT o.*
     FROM lotto_lab_delivery_outbox o
     WHERE o.delivery_id = ?1`
  )
    .bind(deliveryId)
    .first<LabDeliveryRow>();
  if (!row) return null;
  if (row.status === "sent") {
    return {
      deliveryId,
      status: "sent",
      attempts: row.attempt_count,
      nextAttemptAt: null,
      deliveredAt: row.delivered_at
    };
  }
  if (row.status !== "leased" || row.lease_token !== input.leaseToken) {
    throw new Error("delivery lease does not match the active claim");
  }
  if (input.status === "sent" && !input.externalId?.trim())
    throw new RangeError("externalId is required when status is sent");
  const completedAt = now.toISOString();
  const attemptCount = row.attempt_count + input.attempts;
  const status: DeliveryResult["status"] =
    input.status === "sent"
      ? "sent"
      : input.status === "ambiguous"
        ? "ambiguous"
        : input.attempts === 0 || attemptCount >= DELIVERY_DEAD_ATTEMPTS
          ? "dead"
          : "retry";
  const nextAttemptAt =
    status === "retry" ? new Date(now.getTime() + 30 * 60_000).toISOString() : null;
  const deliveredAt = status === "sent" ? completedAt : null;
  const externalId = bounded(input.externalId, 500);
  const error = bounded(input.error, 2_000);
  const alertStatus = bounded(input.alertStatus, 100);
  const alertExternalId = bounded(input.alertExternalId, 500);
  const alertError = bounded(input.alertError, 2_000);
  const transitions = await env.LOTTO_DB.batch([
    env.LOTTO_DB.prepare(
      `INSERT INTO lotto_lab_delivery_attempts
         (delivery_id, lease_token, started_at, completed_at, local_attempts, result,
          external_id, error, alert_status, alert_external_id, alert_error)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11
       WHERE EXISTS (SELECT 1 FROM lotto_lab_delivery_outbox
                     WHERE delivery_id = ?1 AND status = 'leased' AND lease_token = ?2)`
    ).bind(
      deliveryId,
      input.leaseToken,
      row.updated_at,
      completedAt,
      input.attempts,
      input.status,
      externalId,
      error,
      alertStatus,
      alertExternalId,
      alertError
    ),
    env.LOTTO_DB.prepare(
      `UPDATE lotto_lab_delivery_outbox
       SET status = ?1, attempt_count = ?2, next_attempt_at = COALESCE(?3, next_attempt_at),
           lease_token = NULL, lease_expires_at = NULL, external_id = COALESCE(?4, external_id),
           last_error = ?5, alert_status = ?6, alert_external_id = ?7, alert_error = ?8,
           delivered_at = ?9, updated_at = ?10
       WHERE delivery_id = ?11 AND status = 'leased' AND lease_token = ?12`
    ).bind(
      status,
      attemptCount,
      nextAttemptAt,
      externalId,
      error,
      alertStatus,
      alertExternalId,
      alertError,
      deliveredAt,
      completedAt,
      deliveryId,
      input.leaseToken
    )
  ]);
  if ((transitions[0]?.meta.changes ?? 0) !== 1 || (transitions[1]?.meta.changes ?? 0) !== 1)
    throw new Error("delivery lease was lost before the result could be committed");
  console.log(
    JSON.stringify({
      service: "rabbitholetx",
      event: "ticket_lab_delivery_result",
      deliveryId,
      game: row.game,
      drawDate: row.draw_date,
      status,
      attempts: attemptCount
    })
  );
  return { deliveryId, status, attempts: attemptCount, nextAttemptAt, deliveredAt };
}
