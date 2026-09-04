export interface DotCastResolverPanelOpsRow {
  panelId: string;
  poolId: string;
  routeId: string;
  tier: string;
  panelSize: number;
  assignmentCount: number;
  assignedCount: number;
  committedCount: number;
  revealedCount: number;
  paidCount: number;
  slashedCount: number;
  commitCount: number;
  revealCount: number;
  payoutCount: number;
  matchedPayoutCount: number;
  missedPayoutCount: number;
  assignedBondMinorUnits: number;
  returnedBondMinorUnits: number;
  slashedBondMinorUnits: number;
  feePaidMinorUnits: number;
  createdAt: string;
}

export interface DotCastResolverOpsSummary {
  panelCount: number;
  assignmentCount: number;
  assignedCount: number;
  committedCount: number;
  revealedCount: number;
  paidCount: number;
  slashedCount: number;
  assignedBondMinorUnits: number;
}

export interface DotCastUsdcBondOpsSummary {
  lockCount: number;
  lockedCount: number;
  releasedCount: number;
  slashedCount: number;
  lockedMinorUnits: number;
  releasedCreditMinorUnits: number;
  slashedMinorUnits: number;
  byPurposeStatus: {
    purpose: string;
    status: string;
    count: number;
    amountMinorUnits: number;
  }[];
  events: {
    eventType: string;
    count: number;
    amountMinorUnits: number;
    creditMinorUnits: number;
  }[];
}

export interface DotCastUsdcBondReconciliationRow {
  ownerId: string;
  availableUsdc: number;
  ledgerLockedBondUsdc: number;
  expectedLockedBondUsdc: number;
  deltaMinorUnits: number;
  lockCount: number;
  lockedCount: number;
  releasedCount: number;
  slashedCount: number;
}

export interface DotCastUsdcBondEventOpsRow {
  eventId: string;
  lockId: string;
  purpose: string;
  ownerId: string;
  routeId: string | null;
  poolId: string | null;
  panelId: string | null;
  assignmentId: string | null;
  challengeId: string | null;
  eventType: string;
  amount: number;
  credit: number;
  status: string;
  reason: string | null;
  createdAt: string;
}

export interface DotCastResolutionChallengeOpsSummary {
  openCount: number;
  acceptedCount: number;
  rejectedCount: number;
  expiredCount: number;
  withdrawnCount: number;
  bondMinorUnits: number;
}

export interface DotCastResolutionOpsReport {
  generatedAt: string;
  limit: number;
  panels: {
    summary: DotCastResolverOpsSummary;
    recent: DotCastResolverPanelOpsRow[];
  };
  bonds: {
    summary: DotCastUsdcBondOpsSummary;
    reconciliation: {
      mismatchCount: number;
      rows: DotCastUsdcBondReconciliationRow[];
    };
    recentEvents: DotCastUsdcBondEventOpsRow[];
  };
  challenges: {
    summary: DotCastResolutionChallengeOpsSummary;
  };
  flags: string[];
}

export class D1DotCastResolutionOpsReportStore {
  constructor(
    private readonly resolutionDb: D1Database,
    private readonly settlementDb: D1Database = resolutionDb
  ) {}

  async readReport(
    input: { limit?: number; now?: string } = {}
  ): Promise<DotCastResolutionOpsReport> {
    const limit = clampLimit(input.limit);
    const [
      panelSummaryRow,
      assignmentSummaryRow,
      recentPanels,
      bondSummaryRow,
      byPurposeStatusRows,
      bondEventSummaryRows,
      reconciliationRows,
      recentBondEvents,
      challengeSummaryRows
    ] = await Promise.all([
      this.readPanelSummary(),
      this.readAssignmentSummary(),
      this.readRecentPanels(limit),
      this.readBondSummary(),
      this.readBondPurposeStatus(),
      this.readBondEventSummary(),
      this.readBondReconciliation(limit),
      this.readRecentBondEvents(limit),
      this.readChallengeSummary()
    ]);

    const panels = {
      summary: {
        panelCount: rowNumber(panelSummaryRow, "panel_count"),
        assignmentCount: rowNumber(assignmentSummaryRow, "assignment_count"),
        assignedCount: rowNumber(assignmentSummaryRow, "assigned_count"),
        committedCount: rowNumber(assignmentSummaryRow, "committed_count"),
        revealedCount: rowNumber(assignmentSummaryRow, "revealed_count"),
        paidCount: rowNumber(assignmentSummaryRow, "paid_count"),
        slashedCount: rowNumber(assignmentSummaryRow, "slashed_count"),
        assignedBondMinorUnits: rowNumber(assignmentSummaryRow, "assigned_bond_minor_units")
      },
      recent: recentPanels.map(panelOpsFromRow)
    };
    const bonds = {
      summary: {
        lockCount: rowNumber(bondSummaryRow, "lock_count"),
        lockedCount: rowNumber(bondSummaryRow, "locked_count"),
        releasedCount: rowNumber(bondSummaryRow, "released_count"),
        slashedCount: rowNumber(bondSummaryRow, "slashed_count"),
        lockedMinorUnits: rowNumber(bondSummaryRow, "locked_minor_units"),
        releasedCreditMinorUnits: rowNumber(bondSummaryRow, "released_credit_minor_units"),
        slashedMinorUnits: rowNumber(bondSummaryRow, "slashed_minor_units"),
        byPurposeStatus: byPurposeStatusRows.map((row) => ({
          purpose: String(row.purpose ?? "unknown"),
          status: String(row.status ?? "unknown"),
          count: rowNumber(row, "lock_count"),
          amountMinorUnits: rowNumber(row, "amount_minor_units")
        })),
        events: bondEventSummaryRows.map((row) => ({
          eventType: String(row.event_type ?? "unknown"),
          count: rowNumber(row, "event_count"),
          amountMinorUnits: rowNumber(row, "amount_minor_units"),
          creditMinorUnits: rowNumber(row, "credit_minor_units")
        }))
      },
      reconciliation: {
        mismatchCount: reconciliationRows.filter((row) => rowNumber(row, "delta_minor_units") !== 0)
          .length,
        rows: reconciliationRows.map(reconciliationFromRow)
      },
      recentEvents: recentBondEvents.map(bondEventFromRow)
    };
    const challenges = { summary: challengeSummary(challengeSummaryRows) };

    return {
      generatedAt: input.now ?? new Date().toISOString(),
      limit,
      panels,
      bonds,
      challenges,
      flags: buildOpsFlags({ panels, bonds, challenges })
    };
  }

  private async readPanelSummary(): Promise<Record<string, unknown>> {
    return (
      (await this.resolutionDb
        .prepare(
          `SELECT COUNT(*) AS panel_count
           FROM dotcast_resolver_panels`
        )
        .first()) ?? {}
    );
  }

  private async readAssignmentSummary(): Promise<Record<string, unknown>> {
    return (
      (await this.resolutionDb
        .prepare(
          `SELECT COUNT(*) AS assignment_count,
                  COALESCE(SUM(CASE WHEN status = 'assigned' THEN 1 ELSE 0 END), 0) AS assigned_count,
                  COALESCE(SUM(CASE WHEN status = 'committed' THEN 1 ELSE 0 END), 0) AS committed_count,
                  COALESCE(SUM(CASE WHEN status = 'revealed' THEN 1 ELSE 0 END), 0) AS revealed_count,
                  COALESCE(SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END), 0) AS paid_count,
                  COALESCE(SUM(CASE WHEN status = 'slashed' THEN 1 ELSE 0 END), 0) AS slashed_count,
                  COALESCE(SUM(bond_minor_units), 0) AS assigned_bond_minor_units
           FROM dotcast_resolver_assignments`
        )
        .first()) ?? {}
    );
  }

  private async readRecentPanels(limit: number): Promise<Record<string, unknown>[]> {
    const result = await this.resolutionDb
      .prepare(
        `SELECT p.panel_id, p.pool_id, p.route_id, p.tier, p.panel_size, p.created_at,
                COUNT(a.assignment_id) AS assignment_count,
                COALESCE(SUM(CASE WHEN a.status = 'assigned' THEN 1 ELSE 0 END), 0) AS assigned_count,
                COALESCE(SUM(CASE WHEN a.status = 'committed' THEN 1 ELSE 0 END), 0) AS committed_count,
                COALESCE(SUM(CASE WHEN a.status = 'revealed' THEN 1 ELSE 0 END), 0) AS revealed_count,
                COALESCE(SUM(CASE WHEN a.status = 'paid' THEN 1 ELSE 0 END), 0) AS paid_count,
                COALESCE(SUM(CASE WHEN a.status = 'slashed' THEN 1 ELSE 0 END), 0) AS slashed_count,
                COUNT(c.assignment_id) AS commit_count,
                COUNT(r.assignment_id) AS reveal_count,
                COUNT(po.assignment_id) AS payout_count,
                COALESCE(SUM(CASE WHEN po.matched_consensus = 1 THEN 1 ELSE 0 END), 0) AS matched_payout_count,
                COALESCE(SUM(CASE WHEN po.matched_consensus = 0 THEN 1 ELSE 0 END), 0) AS missed_payout_count,
                COALESCE(SUM(a.bond_minor_units), 0) AS assigned_bond_minor_units,
                COALESCE(SUM(po.bond_returned_minor_units), 0) AS returned_bond_minor_units,
                COALESCE(SUM(po.slashed_bond_minor_units), 0) AS slashed_bond_minor_units,
                COALESCE(SUM(po.fee_paid_minor_units), 0) AS fee_paid_minor_units
         FROM dotcast_resolver_panels p
         LEFT JOIN dotcast_resolver_assignments a ON a.panel_id = p.panel_id
         LEFT JOIN dotcast_resolver_commits c ON c.assignment_id = a.assignment_id AND c.panel_id = p.panel_id
         LEFT JOIN dotcast_resolver_reveals r ON r.assignment_id = a.assignment_id AND r.panel_id = p.panel_id
         LEFT JOIN dotcast_resolver_payouts po ON po.assignment_id = a.assignment_id AND po.panel_id = p.panel_id
         GROUP BY p.panel_id, p.pool_id, p.route_id, p.tier, p.panel_size, p.created_at
         ORDER BY p.created_at DESC, p.panel_id DESC
         LIMIT ?`
      )
      .bind(limit)
      .all();

    return result.results ?? [];
  }

  private async readBondSummary(): Promise<Record<string, unknown>> {
    return (
      (await this.settlementDb
        .prepare(
          `SELECT COUNT(*) AS lock_count,
                  COALESCE(SUM(CASE WHEN status = 'locked' THEN 1 ELSE 0 END), 0) AS locked_count,
                  COALESCE(SUM(CASE WHEN status = 'released' THEN 1 ELSE 0 END), 0) AS released_count,
                  COALESCE(SUM(CASE WHEN status = 'slashed' THEN 1 ELSE 0 END), 0) AS slashed_count,
                  COALESCE(SUM(CASE WHEN status = 'locked' THEN amount ELSE 0 END), 0) AS locked_minor_units,
                  COALESCE(SUM(CASE WHEN status = 'released' THEN credit ELSE 0 END), 0) AS released_credit_minor_units,
                  COALESCE(SUM(CASE WHEN status = 'slashed' THEN amount ELSE 0 END), 0) AS slashed_minor_units
           FROM dotcast_usdc_bond_locks`
        )
        .first()) ?? {}
    );
  }

  private async readBondPurposeStatus(): Promise<Record<string, unknown>[]> {
    const result = await this.settlementDb
      .prepare(
        `SELECT purpose, status, COUNT(*) AS lock_count, COALESCE(SUM(amount), 0) AS amount_minor_units
         FROM dotcast_usdc_bond_locks
         GROUP BY purpose, status
         ORDER BY purpose ASC, status ASC`
      )
      .all();

    return result.results ?? [];
  }

  private async readBondEventSummary(): Promise<Record<string, unknown>[]> {
    const result = await this.settlementDb
      .prepare(
        `SELECT event_type, COUNT(*) AS event_count, COALESCE(SUM(amount), 0) AS amount_minor_units,
                COALESCE(SUM(credit), 0) AS credit_minor_units
         FROM dotcast_usdc_bond_events
         GROUP BY event_type
         ORDER BY event_type ASC`
      )
      .all();

    return result.results ?? [];
  }

  private async readBondReconciliation(limit: number): Promise<Record<string, unknown>[]> {
    const result = await this.settlementDb
      .prepare(
        `WITH owners AS (
           SELECT user_id AS owner_id
           FROM dotcast_settlement_balances
           WHERE locked_bond_usdc != 0
           UNION
           SELECT owner_id
           FROM dotcast_usdc_bond_locks
         )
         SELECT o.owner_id,
                COALESCE(b.available_usdc, 0) AS available_usdc,
                COALESCE(b.locked_bond_usdc, 0) AS ledger_locked_bond_usdc,
                COALESCE(SUM(CASE WHEN l.status = 'locked' THEN l.amount ELSE 0 END), 0) AS expected_locked_bond_usdc,
                COALESCE(b.locked_bond_usdc, 0) -
                  COALESCE(SUM(CASE WHEN l.status = 'locked' THEN l.amount ELSE 0 END), 0) AS delta_minor_units,
                COUNT(l.lock_id) AS lock_count,
                COALESCE(SUM(CASE WHEN l.status = 'locked' THEN 1 ELSE 0 END), 0) AS locked_count,
                COALESCE(SUM(CASE WHEN l.status = 'released' THEN 1 ELSE 0 END), 0) AS released_count,
                COALESCE(SUM(CASE WHEN l.status = 'slashed' THEN 1 ELSE 0 END), 0) AS slashed_count
         FROM owners o
         LEFT JOIN dotcast_settlement_balances b ON b.user_id = o.owner_id
         LEFT JOIN dotcast_usdc_bond_locks l ON l.owner_id = o.owner_id
         GROUP BY o.owner_id, b.available_usdc, b.locked_bond_usdc
         ORDER BY ABS(delta_minor_units) DESC, locked_count DESC, o.owner_id ASC
         LIMIT ?`
      )
      .bind(limit)
      .all();

    return result.results ?? [];
  }

  private async readRecentBondEvents(limit: number): Promise<Record<string, unknown>[]> {
    const result = await this.settlementDb
      .prepare(
        `SELECT event_id, lock_id, purpose, owner_id, route_id, pool_id, panel_id, assignment_id,
                challenge_id, event_type, amount, credit, status, reason, created_at
         FROM dotcast_usdc_bond_events
         ORDER BY created_at DESC, event_id DESC
         LIMIT ?`
      )
      .bind(limit)
      .all();

    return result.results ?? [];
  }

  private async readChallengeSummary(): Promise<Record<string, unknown>[]> {
    const result = await this.resolutionDb
      .prepare(
        `SELECT status, COUNT(*) AS challenge_count, COALESCE(SUM(bond_minor_units), 0) AS bond_minor_units
         FROM dotcast_resolution_challenges
         GROUP BY status`
      )
      .all();

    return result.results ?? [];
  }
}

function panelOpsFromRow(row: Record<string, unknown>): DotCastResolverPanelOpsRow {
  return {
    panelId: String(row.panel_id),
    poolId: String(row.pool_id),
    routeId: String(row.route_id),
    tier: String(row.tier),
    panelSize: rowNumber(row, "panel_size"),
    assignmentCount: rowNumber(row, "assignment_count"),
    assignedCount: rowNumber(row, "assigned_count"),
    committedCount: rowNumber(row, "committed_count"),
    revealedCount: rowNumber(row, "revealed_count"),
    paidCount: rowNumber(row, "paid_count"),
    slashedCount: rowNumber(row, "slashed_count"),
    commitCount: rowNumber(row, "commit_count"),
    revealCount: rowNumber(row, "reveal_count"),
    payoutCount: rowNumber(row, "payout_count"),
    matchedPayoutCount: rowNumber(row, "matched_payout_count"),
    missedPayoutCount: rowNumber(row, "missed_payout_count"),
    assignedBondMinorUnits: rowNumber(row, "assigned_bond_minor_units"),
    returnedBondMinorUnits: rowNumber(row, "returned_bond_minor_units"),
    slashedBondMinorUnits: rowNumber(row, "slashed_bond_minor_units"),
    feePaidMinorUnits: rowNumber(row, "fee_paid_minor_units"),
    createdAt: String(row.created_at)
  };
}

function reconciliationFromRow(row: Record<string, unknown>): DotCastUsdcBondReconciliationRow {
  return {
    ownerId: String(row.owner_id),
    availableUsdc: rowNumber(row, "available_usdc"),
    ledgerLockedBondUsdc: rowNumber(row, "ledger_locked_bond_usdc"),
    expectedLockedBondUsdc: rowNumber(row, "expected_locked_bond_usdc"),
    deltaMinorUnits: rowNumber(row, "delta_minor_units"),
    lockCount: rowNumber(row, "lock_count"),
    lockedCount: rowNumber(row, "locked_count"),
    releasedCount: rowNumber(row, "released_count"),
    slashedCount: rowNumber(row, "slashed_count")
  };
}

function bondEventFromRow(row: Record<string, unknown>): DotCastUsdcBondEventOpsRow {
  return {
    eventId: String(row.event_id),
    lockId: String(row.lock_id),
    purpose: String(row.purpose),
    ownerId: String(row.owner_id),
    routeId: nullableText(row.route_id),
    poolId: nullableText(row.pool_id),
    panelId: nullableText(row.panel_id),
    assignmentId: nullableText(row.assignment_id),
    challengeId: nullableText(row.challenge_id),
    eventType: String(row.event_type),
    amount: rowNumber(row, "amount"),
    credit: rowNumber(row, "credit"),
    status: String(row.status),
    reason: nullableText(row.reason),
    createdAt: String(row.created_at)
  };
}

function challengeSummary(rows: Record<string, unknown>[]): DotCastResolutionChallengeOpsSummary {
  const summary: DotCastResolutionChallengeOpsSummary = {
    openCount: 0,
    acceptedCount: 0,
    rejectedCount: 0,
    expiredCount: 0,
    withdrawnCount: 0,
    bondMinorUnits: 0
  };

  for (const row of rows) {
    const count = rowNumber(row, "challenge_count");
    summary.bondMinorUnits += rowNumber(row, "bond_minor_units");

    switch (row.status) {
      case "open":
        summary.openCount += count;
        break;
      case "accepted":
        summary.acceptedCount += count;
        break;
      case "rejected":
        summary.rejectedCount += count;
        break;
      case "expired":
        summary.expiredCount += count;
        break;
      case "withdrawn":
        summary.withdrawnCount += count;
        break;
    }
  }

  return summary;
}

function buildOpsFlags(input: {
  panels: { summary: DotCastResolverOpsSummary; recent: DotCastResolverPanelOpsRow[] };
  bonds: {
    summary: DotCastUsdcBondOpsSummary;
    reconciliation: { mismatchCount: number; rows: DotCastUsdcBondReconciliationRow[] };
  };
  challenges: { summary: DotCastResolutionChallengeOpsSummary };
}): string[] {
  const flags: string[] = [];

  if (input.bonds.reconciliation.mismatchCount > 0) {
    flags.push("bond_reconciliation_mismatch");
  }

  if (input.challenges.summary.openCount > 0) {
    flags.push("open_challenges_hold_optimistic_settlement");
  }

  if (input.panels.recent.some((panel) => panel.assignmentCount < panel.panelSize)) {
    flags.push("panel_under_assigned");
  }

  if (input.panels.summary.slashedCount > 0 || input.bonds.summary.slashedCount > 0) {
    flags.push("resolver_or_bond_slashes_present");
  }

  return flags;
}

function rowNumber(row: Record<string, unknown> | null | undefined, key: string): number {
  const value = row?.[key];
  const numeric = typeof value === "number" ? value : Number(value ?? 0);

  return Number.isFinite(numeric) ? numeric : 0;
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function clampLimit(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value ?? 10);

  if (!Number.isFinite(numeric)) {
    return 10;
  }

  return Math.max(1, Math.min(50, Math.floor(numeric)));
}
