import type {
  DotCastMarketSnapshot,
  DotCastSponsoredQuestion,
  DotCastSponsoredQuestionBillingEvent,
  DotCastSponsoredQuestionBillingEventType,
  DotCastSponsoredQuestionConflictStatus,
  DotCastSponsoredQuestionMarketSource,
  DotCastSponsoredQuestionPricingModel,
  DotCastSponsoredQuestionStatus
} from "./types";

export interface DotCastSponsoredQuestionsEnv {
  DOTCAST_SPONSORED_QUESTIONS_ENABLED?: string;
  DOTCAST_SPONSORED_QUESTION_MAX_CONTEXT_CHARS?: string;
  DOTCAST_SPONSORED_QUESTION_MAX_BRAND_NAME_CHARS?: string;
  DOTCAST_SPONSORED_QUESTION_MIN_BUDGET_MINOR_UNITS?: string;
}

export interface DotCastSponsoredQuestionsStatus {
  enabled: boolean;
  ready: boolean;
  disclosureLabel: "Sponsored";
  pricingModels: DotCastSponsoredQuestionPricingModel[];
  maxContextChars: number;
  maxBrandNameChars: number;
  minBudgetMinorUnits: number;
  guards: string[];
  integrityWall: {
    source: "router-market-only";
    cosmeticOnly: true;
    poolStateWriteAccess: false;
    oddsWriteAccess: false;
    settlementWriteAccess: false;
    userDataReadAccess: false;
  };
}

export interface SponsoredQuestionIntegrityAttestation {
  noOutcomeInfluence?: boolean;
  cosmeticOnly?: boolean;
  noUserDataAccess?: boolean;
}

export interface CreateSponsoredQuestionInput {
  sponsorshipId?: string;
  sponsorId: string;
  campaignId: string;
  market: DotCastMarketSnapshot | DotCastSponsoredQuestionMarketSource;
  pricingModel: DotCastSponsoredQuestionPricingModel;
  budgetMinorUnits?: number;
  placementPriority?: number;
  sponsorName: string;
  brandColor?: string | null;
  logoUrl?: string | null;
  contextText?: string | null;
  sponsorAliases?: string[];
  conflictTerms?: string[];
  relationshipToOutcome?: "none" | "participant" | "issuer" | "candidate" | "organizer" | "other";
  attestation?: SponsoredQuestionIntegrityAttestation;
  status?: DotCastSponsoredQuestionStatus;
  startsAt?: string | null;
  endsAt?: string | null;
  now?: string;
  metadata?: Record<string, unknown>;
}

export interface RecordSponsoredQuestionBillingEventInput {
  sponsorship: DotCastSponsoredQuestion;
  eventType: DotCastSponsoredQuestionBillingEventType;
  quantity?: number;
  amountMinorUnits?: number;
  idempotencyKey?: string;
  now?: string;
  eventJson?: Record<string, unknown>;
}

export interface SponsoredQuestionDisplay {
  sponsorshipId: string;
  disclosureLabel: "Sponsored";
  sponsor: {
    sponsorId: string;
    name: string;
    brandColor: string | null;
    logoUrl: string | null;
  };
  market: DotCastSponsoredQuestionMarketSource;
  contextText: string | null;
  placement: {
    campaignId: string;
    priority: number;
    startsAt: string | null;
    endsAt: string | null;
  };
  integrity: DotCastSponsoredQuestionsStatus["integrityWall"];
}

export interface SponsoredQuestionFeedItem {
  sponsorship: DotCastSponsoredQuestion;
  display: SponsoredQuestionDisplay;
}

export interface DotCastSponsoredQuestionEvent {
  eventId: string;
  sponsorshipId: string;
  sponsorId: string;
  marketId: string;
  eventType:
    | "SPONSORSHIP_CREATED"
    | "CONFLICT_REJECTED"
    | "SPONSORSHIP_STATUS_CHANGED"
    | "BILLING_EVENT_RECORDED";
  status: DotCastSponsoredQuestionStatus | null;
  eventJson: Record<string, unknown>;
  createdAt: string;
}

export interface CreateSponsoredQuestionResult {
  sponsorship: DotCastSponsoredQuestion;
  display: SponsoredQuestionDisplay;
  billingEvent: DotCastSponsoredQuestionBillingEvent | null;
  status: DotCastSponsoredQuestionsStatus;
}

export interface RecordSponsoredQuestionBillingEventResult {
  idempotent: boolean;
  billingEvent: DotCastSponsoredQuestionBillingEvent;
  status: DotCastSponsoredQuestionsStatus;
}

export interface DotCastSponsoredQuestionStore {
  getSponsorship(sponsorshipId: string): Promise<DotCastSponsoredQuestion | null>;
  listFeed(now: string, limit: number): Promise<DotCastSponsoredQuestion[]>;
  listBySponsor(sponsorId: string, limit: number): Promise<DotCastSponsoredQuestion[]>;
  getBillingEventByIdempotencyKey(
    idempotencyKey: string
  ): Promise<DotCastSponsoredQuestionBillingEvent | null>;
  insertSponsorship(
    sponsorship: DotCastSponsoredQuestion,
    event: DotCastSponsoredQuestionEvent,
    billingEvent: DotCastSponsoredQuestionBillingEvent | null
  ): Promise<void>;
  appendEvent(event: DotCastSponsoredQuestionEvent): Promise<void>;
  appendBillingEvent(
    billingEvent: DotCastSponsoredQuestionBillingEvent,
    event: DotCastSponsoredQuestionEvent
  ): Promise<void>;
}

const PRICING_MODELS: DotCastSponsoredQuestionPricingModel[] = [
  "flat_fee",
  "cpm",
  "completed_prediction",
  "auction"
];
const DEFAULT_MAX_CONTEXT_CHARS = 140;
const DEFAULT_MAX_BRAND_NAME_CHARS = 80;
const DEFAULT_MIN_BUDGET_MINOR_UNITS = 0;
const DISCLOSURE_LABEL = "Sponsored";

type SponsoredQuestionRow = Record<string, unknown>;

export class DotCastSponsoredQuestionError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "DotCastSponsoredQuestionError";
    this.code = code;
    this.status = status;
  }
}

export class D1DotCastSponsoredQuestionStore implements DotCastSponsoredQuestionStore {
  constructor(private readonly db: D1Database) {}

  async getSponsorship(sponsorshipId: string): Promise<DotCastSponsoredQuestion | null> {
    const row = await this.db
      .prepare(sponsorshipSelectSql("sponsorship_id = ?"))
      .bind(sponsorshipId)
      .first<SponsoredQuestionRow>();

    return row ? sponsorshipFromRow(row) : null;
  }

  async listFeed(now: string, limit: number): Promise<DotCastSponsoredQuestion[]> {
    const result = await this.db
      .prepare(
        `${sponsorshipSelectSql(
          "status = 'active' AND (starts_at IS NULL OR starts_at <= ?) AND (ends_at IS NULL OR ends_at > ?)"
        )}
         ORDER BY placement_priority DESC, updated_at DESC
         LIMIT ?`
      )
      .bind(now, now, limit)
      .all<SponsoredQuestionRow>();

    return (result.results ?? []).map(sponsorshipFromRow);
  }

  async listBySponsor(sponsorId: string, limit: number): Promise<DotCastSponsoredQuestion[]> {
    const result = await this.db
      .prepare(
        `${sponsorshipSelectSql("sponsor_id = ?")}
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .bind(sponsorId, limit)
      .all<SponsoredQuestionRow>();

    return (result.results ?? []).map(sponsorshipFromRow);
  }

  async getBillingEventByIdempotencyKey(
    idempotencyKey: string
  ): Promise<DotCastSponsoredQuestionBillingEvent | null> {
    const row = await this.db
      .prepare(
        `SELECT billing_event_id, sponsorship_id, sponsor_id, event_type, pricing_model,
                quantity, amount_minor_units, idempotency_key, event_json, created_at
         FROM dotcast_sponsored_question_billing_events
         WHERE idempotency_key = ?`
      )
      .bind(idempotencyKey)
      .first<SponsoredQuestionRow>();

    return row ? billingEventFromRow(row) : null;
  }

  async insertSponsorship(
    sponsorship: DotCastSponsoredQuestion,
    event: DotCastSponsoredQuestionEvent,
    billingEvent: DotCastSponsoredQuestionBillingEvent | null
  ): Promise<void> {
    const statements: D1PreparedStatement[] = [
      this.db.prepare(sponsorshipInsertSql()).bind(...sponsorshipParams(sponsorship)),
      this.db.prepare(eventInsertSql()).bind(...eventParams(event))
    ];

    if (billingEvent) {
      statements.push(
        this.db.prepare(billingEventInsertSql()).bind(...billingEventParams(billingEvent))
      );
      statements.push(
        this.db.prepare(eventInsertSql()).bind(
          ...eventParams(
            buildSponsoredQuestionEvent("BILLING_EVENT_RECORDED", sponsorship, event.createdAt, {
              billingEventId: billingEvent.billingEventId,
              eventType: billingEvent.eventType,
              amountMinorUnits: billingEvent.amountMinorUnits
            })
          )
        )
      );
    }

    await this.db.batch(statements);
  }

  async appendEvent(event: DotCastSponsoredQuestionEvent): Promise<void> {
    await this.db
      .prepare(eventInsertSql())
      .bind(...eventParams(event))
      .run();
  }

  async appendBillingEvent(
    billingEvent: DotCastSponsoredQuestionBillingEvent,
    event: DotCastSponsoredQuestionEvent
  ): Promise<void> {
    await this.db.batch([
      this.db.prepare(billingEventInsertSql()).bind(...billingEventParams(billingEvent)),
      this.db.prepare(eventInsertSql()).bind(...eventParams(event))
    ]);
  }
}

export function readDotCastSponsoredQuestionsStatus(
  env: DotCastSponsoredQuestionsEnv,
  hasDatabase = false
): DotCastSponsoredQuestionsStatus {
  const enabled = env.DOTCAST_SPONSORED_QUESTIONS_ENABLED !== "false";
  const maxContextChars = parsePositiveInt(
    env.DOTCAST_SPONSORED_QUESTION_MAX_CONTEXT_CHARS,
    DEFAULT_MAX_CONTEXT_CHARS,
    "DOTCAST_SPONSORED_QUESTION_MAX_CONTEXT_CHARS"
  );
  const maxBrandNameChars = parsePositiveInt(
    env.DOTCAST_SPONSORED_QUESTION_MAX_BRAND_NAME_CHARS,
    DEFAULT_MAX_BRAND_NAME_CHARS,
    "DOTCAST_SPONSORED_QUESTION_MAX_BRAND_NAME_CHARS"
  );
  const minBudgetMinorUnits = parseNonNegativeInt(
    env.DOTCAST_SPONSORED_QUESTION_MIN_BUDGET_MINOR_UNITS,
    DEFAULT_MIN_BUDGET_MINOR_UNITS,
    "DOTCAST_SPONSORED_QUESTION_MIN_BUDGET_MINOR_UNITS"
  );
  const guards: string[] = [];

  if (!enabled) {
    guards.push("sponsored questions disabled");
  }

  if (!hasDatabase) {
    guards.push("sponsored questions database not configured");
  }

  return {
    enabled,
    ready: enabled && hasDatabase && guards.length === 0,
    disclosureLabel: DISCLOSURE_LABEL,
    pricingModels: PRICING_MODELS,
    maxContextChars,
    maxBrandNameChars,
    minBudgetMinorUnits,
    guards,
    integrityWall: sponsoredQuestionIntegrityWall()
  };
}

export async function createDotCastSponsoredQuestion(
  store: DotCastSponsoredQuestionStore,
  env: DotCastSponsoredQuestionsEnv,
  input: CreateSponsoredQuestionInput,
  hasDatabase = true
): Promise<CreateSponsoredQuestionResult> {
  const status = assertSponsoredQuestionsReady(env, hasDatabase);
  const now = input.now ?? new Date().toISOString();
  const sponsorId = requireText(input.sponsorId, "sponsorId");
  const campaignId = requireText(input.campaignId, "campaignId");
  const market = normalizeRouterMarket(input.market);
  const sponsorshipId =
    input.sponsorshipId ?? `dotcast:e10:sponsorship:${sponsorId}:${campaignId}:${market.id}`;
  const sponsorName = parseLimitedText(input.sponsorName, "sponsorName", status.maxBrandNameChars);
  const contextText = parseOptionalLimitedText(
    input.contextText,
    "contextText",
    status.maxContextChars
  );
  const pricingModel = parsePricingModel(input.pricingModel);
  const budgetMinorUnits = parseMinorUnits(
    input.budgetMinorUnits ?? status.minBudgetMinorUnits,
    "budgetMinorUnits",
    true
  );

  if (budgetMinorUnits < status.minBudgetMinorUnits) {
    throw new DotCastSponsoredQuestionError(
      "SPONSORED_QUESTION_BUDGET_TOO_SMALL",
      "sponsored question budget is below the configured minimum",
      400
    );
  }

  const conflict = evaluateSponsoredQuestionConflict(input, market, sponsorName);
  const baseSponsorship = buildSponsoredQuestionRecord({
    sponsorshipId,
    sponsorId,
    campaignId,
    market,
    pricingModel,
    budgetMinorUnits,
    placementPriority: parseInteger(input.placementPriority ?? 0, "placementPriority"),
    status: conflict.status === "blocked" ? "rejected" : (input.status ?? "active"),
    sponsorName,
    brandColor: parseNullableText(input.brandColor, "brandColor"),
    logoUrl: parseNullableText(input.logoUrl, "logoUrl"),
    contextText,
    conflictStatus: conflict.status,
    conflictReasons: conflict.reasons,
    startsAt: parseNullableText(input.startsAt, "startsAt"),
    endsAt: parseNullableText(input.endsAt, "endsAt"),
    metadata: input.metadata ?? {},
    now
  });

  if (conflict.status === "blocked") {
    await store.appendEvent(
      buildSponsoredQuestionEvent("CONFLICT_REJECTED", baseSponsorship, now, {
        reasons: conflict.reasons,
        sponsorName,
        market: baseSponsorship.market
      })
    );
    throw new DotCastSponsoredQuestionError(
      "SPONSORED_QUESTION_FORBIDDEN_CONFLICT",
      conflict.reasons.join("; "),
      409
    );
  }

  const billingEvent =
    pricingModel === "flat_fee" && budgetMinorUnits > 0
      ? buildSponsoredQuestionBillingEvent(baseSponsorship, {
          eventType: "flat_fee_reserved",
          quantity: 1,
          amountMinorUnits: budgetMinorUnits,
          idempotencyKey: `dotcast:e10:flat-fee:${sponsorshipId}`,
          now,
          eventJson: {
            source: "sponsored_question",
            pricingModel,
            campaignId
          }
        })
      : null;

  await store.insertSponsorship(
    baseSponsorship,
    buildSponsoredQuestionEvent("SPONSORSHIP_CREATED", baseSponsorship, now, {
      pricingModel,
      disclosureLabel: DISCLOSURE_LABEL,
      integrityWall: sponsoredQuestionIntegrityWall()
    }),
    billingEvent
  );

  return {
    sponsorship: baseSponsorship,
    display: projectSponsoredQuestionDisplay(baseSponsorship),
    billingEvent,
    status
  };
}

export async function listDotCastSponsoredQuestionFeed(
  store: DotCastSponsoredQuestionStore,
  env: DotCastSponsoredQuestionsEnv,
  input: { now?: string; limit?: number },
  hasDatabase = true
): Promise<{ items: SponsoredQuestionFeedItem[]; status: DotCastSponsoredQuestionsStatus }> {
  const status = assertSponsoredQuestionsReady(env, hasDatabase);
  const now = input.now ?? new Date().toISOString();
  const limit = parseLimit(input.limit ?? 25);
  const records = await store.listFeed(now, limit);

  return {
    items: records.map((sponsorship) => ({
      sponsorship,
      display: projectSponsoredQuestionDisplay(sponsorship)
    })),
    status
  };
}

export async function recordDotCastSponsoredQuestionBillingEvent(
  store: DotCastSponsoredQuestionStore,
  env: DotCastSponsoredQuestionsEnv,
  input: RecordSponsoredQuestionBillingEventInput,
  hasDatabase = true
): Promise<RecordSponsoredQuestionBillingEventResult> {
  const status = assertSponsoredQuestionsReady(env, hasDatabase);
  const now = input.now ?? new Date().toISOString();
  const eventType = parseBillingEventType(input.eventType);
  assertBillingEventMatchesPricingModel(eventType, input.sponsorship.pricingModel);
  const idempotencyKey =
    input.idempotencyKey ??
    `dotcast:e10:billing:${input.sponsorship.sponsorshipId}:${eventType}:${now}`;
  const existing = await store.getBillingEventByIdempotencyKey(idempotencyKey);

  if (existing) {
    return { idempotent: true, billingEvent: existing, status };
  }

  const billingEvent = buildSponsoredQuestionBillingEvent(input.sponsorship, {
    eventType,
    quantity: parseMinorUnits(input.quantity ?? 1, "quantity"),
    amountMinorUnits: parseMinorUnits(input.amountMinorUnits ?? 0, "amountMinorUnits", true),
    idempotencyKey,
    now,
    eventJson: {
      source: "sponsored_question",
      ...(input.eventJson ?? {})
    }
  });

  await store.appendBillingEvent(
    billingEvent,
    buildSponsoredQuestionEvent("BILLING_EVENT_RECORDED", input.sponsorship, now, {
      billingEventId: billingEvent.billingEventId,
      eventType: billingEvent.eventType,
      amountMinorUnits: billingEvent.amountMinorUnits,
      quantity: billingEvent.quantity
    })
  );

  return { idempotent: false, billingEvent, status };
}

export function projectSponsoredQuestionDisplay(
  sponsorship: DotCastSponsoredQuestion
): SponsoredQuestionDisplay {
  return {
    sponsorshipId: sponsorship.sponsorshipId,
    disclosureLabel: DISCLOSURE_LABEL,
    sponsor: {
      sponsorId: sponsorship.sponsorId,
      name: sponsorship.sponsorName,
      brandColor: sponsorship.brandColor,
      logoUrl: sponsorship.logoUrl
    },
    market: { ...sponsorship.market },
    contextText: sponsorship.contextText,
    placement: {
      campaignId: sponsorship.campaignId,
      priority: sponsorship.placementPriority,
      startsAt: sponsorship.startsAt,
      endsAt: sponsorship.endsAt
    },
    integrity: sponsoredQuestionIntegrityWall()
  };
}

export function withSponsoredQuestionDisclosure<T extends Record<string, unknown>>(
  poolDisplay: T,
  sponsorship: DotCastSponsoredQuestion
): { pool: T; sponsorship: SponsoredQuestionDisplay } {
  return {
    pool: poolDisplay,
    sponsorship: projectSponsoredQuestionDisplay(sponsorship)
  };
}

function assertSponsoredQuestionsReady(
  env: DotCastSponsoredQuestionsEnv,
  hasDatabase: boolean
): DotCastSponsoredQuestionsStatus {
  const status = readDotCastSponsoredQuestionsStatus(env, hasDatabase);

  if (!status.ready) {
    throw new DotCastSponsoredQuestionError(
      "SPONSORED_QUESTIONS_NOT_READY",
      status.guards.join("; ") || "E10 sponsored questions are not ready",
      503
    );
  }

  return status;
}

function evaluateSponsoredQuestionConflict(
  input: CreateSponsoredQuestionInput,
  market: DotCastSponsoredQuestionMarketSource,
  sponsorName: string
): { status: DotCastSponsoredQuestionConflictStatus; reasons: string[] } {
  const reasons: string[] = [];
  const attestation = input.attestation ?? {};

  if (attestation.noOutcomeInfluence !== true) {
    reasons.push("sponsor must attest it cannot influence the outcome");
  }

  if (attestation.cosmeticOnly !== true) {
    reasons.push("sponsor must attest sponsorship controls are cosmetic only");
  }

  if (attestation.noUserDataAccess !== true) {
    reasons.push("sponsor must attest it receives no user or position data");
  }

  if (input.relationshipToOutcome && input.relationshipToOutcome !== "none") {
    reasons.push(`sponsor relationship to outcome is ${input.relationshipToOutcome}`);
  }

  const normalizedQuestion = normalizeSearchText(market.question);
  const terms = uniqueTerms([
    sponsorName,
    ...(input.sponsorAliases ?? []),
    ...(input.conflictTerms ?? [])
  ]);

  for (const term of terms) {
    if (textContainsTerm(normalizedQuestion, term)) {
      reasons.push(`sponsor/conflict term "${term}" appears in the market question`);
    }
  }

  return {
    status: reasons.length > 0 ? "blocked" : "clear",
    reasons
  };
}

function buildSponsoredQuestionRecord(input: {
  sponsorshipId: string;
  sponsorId: string;
  campaignId: string;
  market: DotCastSponsoredQuestionMarketSource;
  pricingModel: DotCastSponsoredQuestionPricingModel;
  budgetMinorUnits: number;
  placementPriority: number;
  status: DotCastSponsoredQuestionStatus;
  sponsorName: string;
  brandColor: string | null;
  logoUrl: string | null;
  contextText: string | null;
  conflictStatus: DotCastSponsoredQuestionConflictStatus;
  conflictReasons: string[];
  startsAt: string | null;
  endsAt: string | null;
  metadata: Record<string, unknown>;
  now: string;
}): DotCastSponsoredQuestion {
  const created: DotCastSponsoredQuestion = {
    sponsorshipId: input.sponsorshipId,
    sponsorId: input.sponsorId,
    campaignId: input.campaignId,
    market: input.market,
    pricingModel: input.pricingModel,
    budgetMinorUnits: input.budgetMinorUnits,
    placementPriority: input.placementPriority,
    status: input.status,
    disclosureLabel: DISCLOSURE_LABEL,
    sponsorName: input.sponsorName,
    brandColor: input.brandColor,
    logoUrl: input.logoUrl,
    contextText: input.contextText,
    conflictStatus: input.conflictStatus,
    conflictReasons: input.conflictReasons,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    metadata: input.metadata,
    integrityHash: "",
    createdAt: input.now,
    updatedAt: input.now
  };

  return {
    ...created,
    integrityHash: stableIntegrityHash(created)
  };
}

function buildSponsoredQuestionEvent(
  eventType: DotCastSponsoredQuestionEvent["eventType"],
  sponsorship: DotCastSponsoredQuestion,
  now: string,
  eventJson: Record<string, unknown>
): DotCastSponsoredQuestionEvent {
  return {
    eventId: `dotcast:e10:event:${sponsorship.sponsorshipId}:${eventType}:${Date.parse(now)}`,
    sponsorshipId: sponsorship.sponsorshipId,
    sponsorId: sponsorship.sponsorId,
    marketId: sponsorship.market.id,
    eventType,
    status: sponsorship.status,
    eventJson,
    createdAt: now
  };
}

function buildSponsoredQuestionBillingEvent(
  sponsorship: DotCastSponsoredQuestion,
  input: {
    eventType: DotCastSponsoredQuestionBillingEventType;
    quantity: number;
    amountMinorUnits: number;
    idempotencyKey: string;
    now: string;
    eventJson: Record<string, unknown>;
  }
): DotCastSponsoredQuestionBillingEvent {
  return {
    billingEventId: `dotcast:e10:billing:${input.idempotencyKey}`,
    sponsorshipId: sponsorship.sponsorshipId,
    sponsorId: sponsorship.sponsorId,
    eventType: input.eventType,
    pricingModel: sponsorship.pricingModel,
    quantity: input.quantity,
    amountMinorUnits: input.amountMinorUnits,
    idempotencyKey: input.idempotencyKey,
    eventJson: input.eventJson,
    createdAt: input.now
  };
}

function sponsoredQuestionIntegrityWall(): DotCastSponsoredQuestionsStatus["integrityWall"] {
  return {
    source: "router-market-only",
    cosmeticOnly: true,
    poolStateWriteAccess: false,
    oddsWriteAccess: false,
    settlementWriteAccess: false,
    userDataReadAccess: false
  };
}

function normalizeRouterMarket(
  market: DotCastMarketSnapshot | DotCastSponsoredQuestionMarketSource
): DotCastSponsoredQuestionMarketSource {
  const venue = market.venue;

  if (venue !== "kalshi" && venue !== "polymarket") {
    throw new DotCastSponsoredQuestionError(
      "SPONSORED_QUESTION_REQUIRES_ROUTER_MARKET",
      "sponsored questions must source from a real Kalshi or Polymarket router market",
      400
    );
  }

  if (market.status === "cancelled" || market.status === "voided") {
    throw new DotCastSponsoredQuestionError(
      "SPONSORED_QUESTION_MARKET_NOT_ELIGIBLE",
      "cancelled or voided markets cannot be sponsored",
      409
    );
  }

  return {
    id: requireText(market.id, "market.id"),
    venue,
    question: requireText(market.question, "market.question"),
    status: market.status,
    closeTime: requireText(market.closeTime, "market.closeTime"),
    expectedResolveAt: parseNullableText(market.expectedResolveAt, "market.expectedResolveAt"),
    referenceUrl: parseNullableText(market.referenceUrl, "market.referenceUrl")
  };
}

function assertBillingEventMatchesPricingModel(
  eventType: DotCastSponsoredQuestionBillingEventType,
  pricingModel: DotCastSponsoredQuestionPricingModel
): void {
  const compatible =
    eventType === "adjustment" ||
    (eventType === "flat_fee_reserved" && pricingModel === "flat_fee") ||
    (eventType === "impression" && pricingModel === "cpm") ||
    (eventType === "completed_prediction" && pricingModel === "completed_prediction") ||
    (eventType === "auction_charge" && pricingModel === "auction");

  if (!compatible) {
    throw new DotCastSponsoredQuestionError(
      "SPONSORED_QUESTION_BILLING_MODEL_MISMATCH",
      "billing event type does not match the sponsorship pricing model",
      409
    );
  }
}

function sponsorshipSelectSql(where: string): string {
  return `SELECT sponsorship_id, sponsor_id, campaign_id, market_id, venue, question,
                 market_status, close_time, expected_resolve_at, reference_url, pricing_model,
                 budget_minor_units, placement_priority, status, disclosure_label, sponsor_name,
                 brand_color, logo_url, context_text, conflict_status, conflict_reasons_json,
                 starts_at, ends_at, metadata_json, integrity_hash, created_at, updated_at
          FROM dotcast_sponsored_questions
          WHERE ${where}`;
}

function sponsorshipInsertSql(): string {
  return `INSERT INTO dotcast_sponsored_questions (
            sponsorship_id, sponsor_id, campaign_id, market_id, venue, question,
            market_status, close_time, expected_resolve_at, reference_url, pricing_model,
            budget_minor_units, placement_priority, status, disclosure_label, sponsor_name,
            brand_color, logo_url, context_text, conflict_status, conflict_reasons_json,
            starts_at, ends_at, metadata_json, integrity_hash, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
}

function eventInsertSql(): string {
  return `INSERT OR IGNORE INTO dotcast_sponsored_question_events (
            event_id, sponsorship_id, sponsor_id, market_id, event_type, status, event_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
}

function billingEventInsertSql(): string {
  return `INSERT OR IGNORE INTO dotcast_sponsored_question_billing_events (
            billing_event_id, sponsorship_id, sponsor_id, event_type, pricing_model,
            quantity, amount_minor_units, idempotency_key, event_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
}

function sponsorshipParams(sponsorship: DotCastSponsoredQuestion): unknown[] {
  return [
    sponsorship.sponsorshipId,
    sponsorship.sponsorId,
    sponsorship.campaignId,
    sponsorship.market.id,
    sponsorship.market.venue,
    sponsorship.market.question,
    sponsorship.market.status,
    sponsorship.market.closeTime,
    sponsorship.market.expectedResolveAt,
    sponsorship.market.referenceUrl,
    sponsorship.pricingModel,
    sponsorship.budgetMinorUnits,
    sponsorship.placementPriority,
    sponsorship.status,
    sponsorship.disclosureLabel,
    sponsorship.sponsorName,
    sponsorship.brandColor,
    sponsorship.logoUrl,
    sponsorship.contextText,
    sponsorship.conflictStatus,
    JSON.stringify(sponsorship.conflictReasons),
    sponsorship.startsAt,
    sponsorship.endsAt,
    JSON.stringify(sponsorship.metadata),
    sponsorship.integrityHash,
    sponsorship.createdAt,
    sponsorship.updatedAt
  ];
}

function eventParams(event: DotCastSponsoredQuestionEvent): unknown[] {
  return [
    event.eventId,
    event.sponsorshipId,
    event.sponsorId,
    event.marketId,
    event.eventType,
    event.status,
    JSON.stringify(event.eventJson),
    event.createdAt
  ];
}

function billingEventParams(event: DotCastSponsoredQuestionBillingEvent): unknown[] {
  return [
    event.billingEventId,
    event.sponsorshipId,
    event.sponsorId,
    event.eventType,
    event.pricingModel,
    event.quantity,
    event.amountMinorUnits,
    event.idempotencyKey,
    JSON.stringify(event.eventJson),
    event.createdAt
  ];
}

function sponsorshipFromRow(row: SponsoredQuestionRow): DotCastSponsoredQuestion {
  return {
    sponsorshipId: requireText(row.sponsorship_id, "sponsorship_id"),
    sponsorId: requireText(row.sponsor_id, "sponsor_id"),
    campaignId: requireText(row.campaign_id, "campaign_id"),
    market: {
      id: requireText(row.market_id, "market_id"),
      venue: parseRouterVenue(row.venue),
      question: requireText(row.question, "question"),
      status: parseMarketStatus(row.market_status),
      closeTime: requireText(row.close_time, "close_time"),
      expectedResolveAt: parseNullableText(row.expected_resolve_at, "expected_resolve_at"),
      referenceUrl: parseNullableText(row.reference_url, "reference_url")
    },
    pricingModel: parsePricingModel(row.pricing_model),
    budgetMinorUnits: requireInt(row.budget_minor_units, "budget_minor_units"),
    placementPriority: requireInt(row.placement_priority, "placement_priority"),
    status: parseSponsorshipStatus(row.status),
    disclosureLabel: parseDisclosure(row.disclosure_label),
    sponsorName: requireText(row.sponsor_name, "sponsor_name"),
    brandColor: parseNullableText(row.brand_color, "brand_color"),
    logoUrl: parseNullableText(row.logo_url, "logo_url"),
    contextText: parseNullableText(row.context_text, "context_text"),
    conflictStatus: parseConflictStatus(row.conflict_status),
    conflictReasons: parseStringArray(row.conflict_reasons_json),
    startsAt: parseNullableText(row.starts_at, "starts_at"),
    endsAt: parseNullableText(row.ends_at, "ends_at"),
    metadata: parseJsonObject(row.metadata_json),
    integrityHash: requireText(row.integrity_hash, "integrity_hash"),
    createdAt: requireText(row.created_at, "created_at"),
    updatedAt: requireText(row.updated_at, "updated_at")
  };
}

function billingEventFromRow(row: SponsoredQuestionRow): DotCastSponsoredQuestionBillingEvent {
  return {
    billingEventId: requireText(row.billing_event_id, "billing_event_id"),
    sponsorshipId: requireText(row.sponsorship_id, "sponsorship_id"),
    sponsorId: requireText(row.sponsor_id, "sponsor_id"),
    eventType: parseBillingEventType(row.event_type),
    pricingModel: parsePricingModel(row.pricing_model),
    quantity: requireInt(row.quantity, "quantity"),
    amountMinorUnits: requireInt(row.amount_minor_units, "amount_minor_units"),
    idempotencyKey: requireText(row.idempotency_key, "idempotency_key"),
    eventJson: parseJsonObject(row.event_json),
    createdAt: requireText(row.created_at, "created_at")
  };
}

function parsePricingModel(value: unknown): DotCastSponsoredQuestionPricingModel {
  if (
    value === "flat_fee" ||
    value === "cpm" ||
    value === "completed_prediction" ||
    value === "auction"
  ) {
    return value;
  }

  throw new DotCastSponsoredQuestionError(
    "INVALID_SPONSORED_QUESTION_PRICING_MODEL",
    "sponsored question pricing model is invalid",
    400
  );
}

function parseBillingEventType(value: unknown): DotCastSponsoredQuestionBillingEventType {
  if (
    value === "flat_fee_reserved" ||
    value === "impression" ||
    value === "completed_prediction" ||
    value === "auction_charge" ||
    value === "adjustment"
  ) {
    return value;
  }

  throw new DotCastSponsoredQuestionError(
    "INVALID_SPONSORED_QUESTION_BILLING_EVENT",
    "sponsored question billing event type is invalid",
    400
  );
}

function parseSponsorshipStatus(value: unknown): DotCastSponsoredQuestionStatus {
  if (
    value === "pending_review" ||
    value === "active" ||
    value === "paused" ||
    value === "archived" ||
    value === "rejected"
  ) {
    return value;
  }

  throw new DotCastSponsoredQuestionError(
    "INVALID_SPONSORED_QUESTION_STATUS",
    "sponsored question status is invalid",
    500
  );
}

function parseConflictStatus(value: unknown): DotCastSponsoredQuestionConflictStatus {
  if (value === "clear" || value === "blocked" || value === "pending") {
    return value;
  }

  throw new DotCastSponsoredQuestionError(
    "INVALID_SPONSORED_QUESTION_CONFLICT_STATUS",
    "sponsored question conflict status is invalid",
    500
  );
}

function parseMarketStatus(value: unknown): DotCastMarketSnapshot["status"] {
  if (
    value === "open" ||
    value === "closed" ||
    value === "settled" ||
    value === "cancelled" ||
    value === "voided"
  ) {
    return value;
  }

  throw new DotCastSponsoredQuestionError(
    "INVALID_SPONSORED_QUESTION_MARKET_STATUS",
    "sponsored question market status is invalid",
    500
  );
}

function parseRouterVenue(value: unknown): DotCastSponsoredQuestionMarketSource["venue"] {
  if (value === "kalshi" || value === "polymarket") {
    return value;
  }

  throw new DotCastSponsoredQuestionError(
    "INVALID_SPONSORED_QUESTION_VENUE",
    "sponsored question venue must be kalshi or polymarket",
    500
  );
}

function parseDisclosure(value: unknown): "Sponsored" {
  if (value === DISCLOSURE_LABEL) {
    return value;
  }

  throw new DotCastSponsoredQuestionError(
    "INVALID_SPONSORED_QUESTION_DISCLOSURE",
    "sponsored question disclosure label must be Sponsored",
    500
  );
}

function parseLimitedText(value: unknown, label: string, maxChars: number): string {
  const parsed = requireText(value, label);

  if (parsed.length > maxChars) {
    throw new DotCastSponsoredQuestionError(
      "SPONSORED_QUESTION_TEXT_TOO_LONG",
      `${label} exceeds ${maxChars} characters`,
      400
    );
  }

  return parsed;
}

function parseOptionalLimitedText(value: unknown, label: string, maxChars: number): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  return parseLimitedText(value, label, maxChars);
}

function requireText(value: unknown, label: string): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  throw new DotCastSponsoredQuestionError(
    "INVALID_SPONSORED_QUESTION_INPUT",
    `${label} is required`,
    400
  );
}

function parseNullableText(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  return requireText(value, label);
}

function parseMinorUnits(value: unknown, label: string, allowZero = false): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    (!allowZero && value === 0)
  ) {
    throw new DotCastSponsoredQuestionError(
      "INVALID_SPONSORED_QUESTION_AMOUNT",
      `${label} must be ${allowZero ? "a non-negative" : "a positive"} integer amount`,
      400
    );
  }

  return value;
}

function parseInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new DotCastSponsoredQuestionError(
      "INVALID_SPONSORED_QUESTION_INTEGER",
      `${label} must be a safe integer`,
      400
    );
  }

  return value;
}

function parseLimit(value: unknown): number {
  const parsed = parseMinorUnits(value, "limit");

  return Math.min(100, parsed);
}

function requireInt(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return value;
  }

  throw new DotCastSponsoredQuestionError(
    "INVALID_SPONSORED_QUESTION_ROW",
    `${label} must be a safe integer`,
    500
  );
}

function parsePositiveInt(value: string | undefined, fallback: number, label: string): number {
  const parsed = parseOptionalInt(value, fallback, label);

  if (parsed <= 0) {
    throw new DotCastSponsoredQuestionError(
      "INVALID_SPONSORED_QUESTION_CONFIG",
      `${label} must be positive`,
      500
    );
  }

  return parsed;
}

function parseNonNegativeInt(value: string | undefined, fallback: number, label: string): number {
  const parsed = parseOptionalInt(value, fallback, label);

  if (parsed < 0) {
    throw new DotCastSponsoredQuestionError(
      "INVALID_SPONSORED_QUESTION_CONFIG",
      `${label} must be non-negative`,
      500
    );
  }

  return parsed;
}

function parseOptionalInt(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed)) {
    throw new DotCastSponsoredQuestionError(
      "INVALID_SPONSORED_QUESTION_CONFIG",
      `${label} must be a safe integer`,
      500
    );
  }

  return parsed;
}

function parseStringArray(value: unknown): string[] {
  if (typeof value !== "string" || value.length === 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((candidate): candidate is string => typeof candidate === "string")
      : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || value.length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function uniqueTerms(values: string[]): string[] {
  const terms = new Set<string>();

  for (const value of values) {
    const normalized = normalizeSearchText(value);

    if (normalized.length >= 3) {
      terms.add(normalized);
    }
  }

  return [...terms];
}

function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function textContainsTerm(normalizedText: string, normalizedTerm: string): boolean {
  if (normalizedTerm.length < 3) {
    return false;
  }

  return new RegExp(`(^| )${escapeRegex(normalizedTerm)}( |$)`).test(normalizedText);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stableIntegrityHash(sponsorship: DotCastSponsoredQuestion): string {
  const payload = JSON.stringify({
    market: sponsorship.market,
    pricingModel: sponsorship.pricingModel,
    disclosureLabel: sponsorship.disclosureLabel,
    sponsorName: sponsorship.sponsorName,
    contextText: sponsorship.contextText
  });
  let hash = 0x811c9dc5;

  for (let index = 0; index < payload.length; index += 1) {
    hash ^= payload.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
