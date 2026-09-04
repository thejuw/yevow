"use client";

import {
  CheckCircle2,
  CircleAlert,
  FlaskConical,
  History,
  LockKeyhole,
  RefreshCw,
  Scale,
  Trophy
} from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import {
  GAME_CODES,
  GAME_MANIFEST,
  LottoTicketLabClientError,
  formatMoneyCents,
  readTicketLabEntries,
  readTicketLabSummary,
  type GameCode,
  type TicketLabEntriesResponse,
  type TicketLabEntry,
  type TicketLabEntryStatus,
  type TicketLabOrigin,
  type TicketLabScorecard,
  type TicketLabSummaryResponse
} from "@/lib/lotto";

type LabState =
  | { readonly phase: "loading" }
  | { readonly phase: "locked" }
  | { readonly phase: "unavailable" }
  | {
      readonly phase: "ready";
      readonly summary: TicketLabSummaryResponse;
      readonly entries: TicketLabEntriesResponse;
    };

interface AppliedFilters {
  readonly game?: GameCode;
  readonly from?: string;
  readonly to?: string;
  readonly status?: TicketLabEntryStatus;
}

const ORIGIN_LABEL: Readonly<Record<TicketLabOrigin, string>> = {
  system: "RabbitHoleTX",
  random: "Random baseline",
  user: "Hand-picked"
};

const STATUS_LABEL: Readonly<Record<TicketLabEntryStatus, string>> = {
  open: "Open",
  graded: "All graded",
  pending: "Pending payout",
  won: "Winners",
  lost: "Misses"
};

const integerFormatter = new Intl.NumberFormat("en-US");

function displayDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "numeric"
  }).format(new Date(`${value}T12:00:00.000Z`));
}

function displayDateTime(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short"
  }).format(new Date(value));
}

function roi(value: number | null): string {
  if (value === null) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function originClass(origin: TicketLabOrigin): string {
  return `lotto-track-origin is-${origin}`;
}

function outcomeLabel(entry: TicketLabEntry): string {
  if (entry.tickets.every((ticket) => ticket.grade === null)) return "Open";
  if (entry.pendingPrizeCount > 0) return "Payout pending";
  if (entry.tickets.some((ticket) => ticket.grade?.hit)) return "Winner";
  return "Graded miss";
}

function purchaseLabel(entry: TicketLabEntry): string {
  if (entry.purchase.status === "confirmed") return "confirmed purchase";
  if (entry.purchase.status === "declined") return "not purchased";
  if (entry.origin === "random") return "comparison control";
  if (entry.origin === "user") return "hand-picked proposal";
  return "system proposal";
}

function settlementEvidenceLabel(evidence: Readonly<Record<string, unknown>>): string {
  const parts: string[] = [];
  if (Number.isSafeInteger(evidence.certifiedWinnerCount)) {
    parts.push(`${evidence.certifiedWinnerCount as number} certified winner(s)`);
  }
  if (typeof evidence.officialSourceSha256 === "string") {
    parts.push(`source SHA ${evidence.officialSourceSha256.slice(0, 12)}…`);
  }
  return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
}

function optionSummary(options: Readonly<Record<string, unknown>>): string {
  const rendered: string[] = [];
  for (const [key, value] of Object.entries(options)) {
    if (value === null || value === false || value === "" || key.endsWith("Provenance")) continue;
    const label = key
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replaceAll("_", " ")
      .toLowerCase();
    rendered.push(value === true ? label : `${label}: ${String(value)}`);
  }
  return rendered.length > 0 ? rendered.join(" · ") : "base play";
}

function ScorecardMetric({
  label,
  value,
  detail,
  tone
}: {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
  readonly tone?: "negative" | "positive";
}) {
  return (
    <div className={tone ? `lotto-track-metric is-${tone}` : "lotto-track-metric"}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function ComparisonCard({ row }: { readonly row: TicketLabScorecard & { origin: TicketLabOrigin } }) {
  return (
    <article className="lotto-comparison-card">
      <header>
        <span className={originClass(row.origin)}>{ORIGIN_LABEL[row.origin]}</span>
        <strong className={(row.roiPercent ?? 0) < 0 ? "lotto-negative" : "lotto-positive"}>
          {roi(row.roiPercent)} cash ROI
        </strong>
      </header>
      <dl>
        <div>
          <dt>Sample</dt>
          <dd>{integerFormatter.format(row.gradedTickets)} graded</dd>
        </div>
        <div>
          <dt>Spent</dt>
          <dd>{formatMoneyCents(row.spentCents)}</dd>
        </div>
        <div>
          <dt>Returned</dt>
          <dd>
            {formatMoneyCents(row.wonCents)} cash
            {row.nonCashValueCents > 0
              ? ` + ${formatMoneyCents(row.nonCashValueCents)} noncash`
              : ""}
          </dd>
        </div>
        <div>
          <dt>Economic ROI</dt>
          <dd>{roi(row.economicRoiPercent)}</dd>
        </div>
        <div>
          <dt>Longest miss run</dt>
          <dd>{integerFormatter.format(row.longestLosingStreak)}</dd>
        </div>
      </dl>
      <p>
        {row.bestHit
          ? row.bestHit.payoutStatus === "pending"
            ? `Best: ${row.bestHit.tier}, official payout pending on ${displayDate(row.bestHit.drawDate)}.`
            : `Best: ${row.bestHit.tier}, ${formatMoneyCents(row.bestHit.prizeCents ?? 0)} on ${displayDate(row.bestHit.drawDate)}.`
          : row.gradedTickets > 0
            ? "No prize-tier hit in this sample."
            : "No graded sample yet."}
      </p>
    </article>
  );
}

function BallSet({
  game,
  main,
  bonus
}: {
  readonly game: GameCode;
  readonly main: readonly number[];
  readonly bonus: readonly number[];
}) {
  const digits = game === "p3" || game === "d4";
  return (
    <div className={digits ? "lotto-balls digits" : "lotto-balls"}>
      {main.map((value, index) => (
        <span key={`${index}-${value}`}>{digits ? value : String(value).padStart(2, "0")}</span>
      ))}
      {bonus.length > 0 ? <i>+</i> : null}
      {bonus.map((value, index) => (
        <span className="bonus" key={`bonus-${index}-${value}`}>
          {String(value).padStart(2, "0")}
        </span>
      ))}
    </div>
  );
}

function LedgerEntryCard({ entry }: { readonly entry: TicketLabEntry }) {
  const status = outcomeLabel(entry);
  const officialGrade = entry.tickets.find((ticket) => ticket.grade !== null)?.grade ?? null;
  return (
    <article className="lotto-ledger-entry">
      <header className="lotto-ledger-entry-head">
        <div>
          <span className={originClass(entry.origin)}>{ORIGIN_LABEL[entry.origin]}</span>
          <h4>{entry.gameName}</h4>
          <p>
            {displayDate(entry.drawDate)}
            {entry.targetSession ? ` · ${entry.targetSession} draw` : ""}
          </p>
        </div>
        <div>
          <span
            className={
              status === "Winner"
                ? "lotto-ledger-status is-win"
                : status === "Payout pending"
                  ? "lotto-ledger-status is-pending"
                  : "lotto-ledger-status"
            }
          >
            {status}
          </span>
          <small>{purchaseLabel(entry)}</small>
        </div>
      </header>

      {officialGrade ? (
        <div className="lotto-ledger-result">
          <div>
            <span>Official result</span>
            <BallSet
              game={entry.game}
              main={officialGrade.result.main}
              bonus={officialGrade.result.bonus}
            />
          </div>
          <small>
            Grade revision {officialGrade.revision} · result source {officialGrade.result.sourceId} · source SHA {officialGrade.result.sourceSha256.slice(0, 12)}… · fingerprint {officialGrade.result.fingerprint.slice(0, 12)}… · {displayDateTime(officialGrade.gradedAt)}
          </small>
        </div>
      ) : null}

      <ol className="lotto-ledger-ticket-list" aria-label={`${entry.gameName} ledger tickets`}>
        {entry.tickets.map((ticket) => (
          <li key={ticket.ledgerTicketId}>
            <span className="lotto-ticket-index">{String(ticket.ordinal).padStart(2, "0")}</span>
            <div>
              <BallSet game={entry.game} main={ticket.main} bonus={ticket.bonus} />
              <small>{optionSummary(ticket.options)}</small>
            </div>
            <div className="lotto-ledger-grade">
              {ticket.grade ? (
                <>
                  <strong className={ticket.grade.hit ? "lotto-positive" : ""}>
                    {ticket.grade.hit ? ticket.grade.tier : `${ticket.grade.mainMatches}/${ticket.main.length}`}
                  </strong>
                  <small>
                    {ticket.grade.mainMatches}/{ticket.main.length} main
                    {ticket.bonus.length > 0 ? ` · ${ticket.grade.bonusMatches}/${ticket.bonus.length} bonus` : ""}
                  </small>
                  <span>
                    {ticket.grade.payoutStatus === "pending"
                      ? "pari-mutuel amount pending"
                      : ticket.grade.nonCashPrize
                        ? ticket.grade.nonCashPrize
                        : formatMoneyCents(ticket.grade.effectivePrizeCents ?? 0)}
                  </span>
                  {ticket.grade.settlement ? (
                    <small>
                      settled {displayDateTime(ticket.grade.settlement.settledAt)} · {ticket.grade.settlement.source}
                      {settlementEvidenceLabel(ticket.grade.settlement.evidence)}
                    </small>
                  ) : null}
                </>
              ) : (
                <>
                  <strong>Awaiting draw</strong>
                  <span>not graded</span>
                </>
              )}
            </div>
          </li>
        ))}
      </ol>

      <footer className="lotto-ledger-entry-foot">
        <dl>
          <div>
            <dt>Proposal spend</dt>
            <dd>{formatMoneyCents(entry.spend.proposalCents)}</dd>
          </div>
          <div>
            <dt>Confirmed spend</dt>
            <dd>{formatMoneyCents(entry.spend.confirmedCents)}</dd>
          </div>
          <div>
            <dt>Cash return</dt>
            <dd>{formatMoneyCents(entry.wonCents)}</dd>
          </div>
          <div>
            <dt>Coverage</dt>
            <dd>{entry.coverage.percent.toFixed(2)}%</dd>
          </div>
        </dl>
        <details>
          <summary>Immutable generation evidence</summary>
          <p>
            Ledger {entry.ledgerId} · proposed {displayDateTime(entry.proposedAt)} · seed {entry.seed ?? "not applicable"}
            {entry.data.observedThrough ? ` · data through ${entry.data.observedThrough}` : ""}
            {entry.data.datasetDigest ? ` · dataset ${entry.data.datasetDigest.slice(0, 12)}…` : ""}
            {entry.runId ? ` · generation ${entry.runId}` : ""}
            {entry.baselineFor ? ` · baseline for ${entry.baselineFor}` : ""}
          </p>
          <p>{entry.ev.assumption}</p>
        </details>
      </footer>
    </article>
  );
}

export default function LottoTicketLabPanel() {
  const [state, setState] = useState<LabState>({ phase: "loading" });
  const [game, setGame] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [status, setStatus] = useState("");
  const [filters, setFilters] = useState<AppliedFilters>({});
  const [requestVersion, setRequestVersion] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8_000);
    const token = window.localStorage.getItem("sovereign.jwt")?.trim() ?? "";
    if (!token) {
      window.clearTimeout(timeout);
      setState({ phase: "locked" });
      return () => {
        active = false;
        controller.abort();
      };
    }
    setState({ phase: "loading" });
    void Promise.all([
      readTicketLabSummary(filters, { token, signal: controller.signal }),
      readTicketLabEntries({ ...filters, limit: 20 }, { token, signal: controller.signal })
    ])
      .then(([summary, entries]) => {
        if (active) setState({ phase: "ready", summary, entries });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setState(
          error instanceof LottoTicketLabClientError && error.status === 401
            ? { phase: "locked" }
            : { phase: "unavailable" }
        );
      })
      .finally(() => window.clearTimeout(timeout));
    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [filters, requestVersion]);

  const proposal = state.phase === "ready" ? state.summary.data.totals.proposals : null;
  const confirmed = state.phase === "ready" ? state.summary.data.totals.confirmed : null;
  const comparisons = state.phase === "ready" ? state.summary.data.comparisons : [];
  const entries = state.phase === "ready" ? state.entries.data.entries : [];
  const hasUserComparison = comparisons.some((row) => row.origin === "user" && row.tickets > 0);
  const resultCount = useMemo(
    () => entries.reduce((total, entry) => total + entry.tickets.length, 0),
    [entries]
  );

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (from && to && from > to) return;
    setFilters({
      ...(game ? { game: game as GameCode } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(status ? { status: status as TicketLabEntryStatus } : {})
    });
  }

  function clearFilters() {
    setGame("");
    setFrom("");
    setTo("");
    setStatus("");
    setFilters({});
  }

  async function loadMore() {
    if (state.phase !== "ready" || !state.entries.data.nextCursor || loadingMore) return;
    setLoadingMore(true);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8_000);
    try {
      const token = window.localStorage.getItem("sovereign.jwt")?.trim() ?? "";
      const next = await readTicketLabEntries(
        { ...filters, limit: 20, cursor: state.entries.data.nextCursor },
        { token, signal: controller.signal }
      );
      setState({
        phase: "ready",
        summary: state.summary,
        entries: {
          ...next,
          data: {
            ...next.data,
            entries: [...state.entries.data.entries, ...next.data.entries]
          }
        }
      });
    } catch {
      // Preserve already verified rows. The user can retry pagination without losing context.
    } finally {
      window.clearTimeout(timeout);
      setLoadingMore(false);
    }
  }

  return (
    <section className="lotto-trackrecord" aria-labelledby="lotto-trackrecord-title">
      <header className="lotto-trackrecord-head">
        <span className="lotto-trackrecord-icon" aria-hidden="true">
          <FlaskConical size={20} />
        </span>
        <div>
          <p>FORWARD-TESTED TICKET LEDGER</p>
          <h2 id="lotto-trackrecord-title">Nothing forgotten. Nothing hidden.</h2>
          <span>
            Every autonomous set is frozen before its draw, graded against official results, and kept in an append-only record.
          </span>
        </div>
        <button
          type="button"
          onClick={() => setRequestVersion((version) => version + 1)}
          disabled={state.phase === "loading"}
        >
          <RefreshCw className={state.phase === "loading" ? "lotto-spin" : ""} size={13} />
          Refresh ledger
        </button>
      </header>

      {state.phase === "ready" && proposal && confirmed ? (
        <>
          <div className="lotto-track-metrics" aria-label="Ticket Lab aggregate scorecard">
            <ScorecardMetric
              label="Proposed tickets"
              value={integerFormatter.format(proposal.gradedTickets)}
              detail={`${integerFormatter.format(proposal.tickets)} tracked total`}
            />
            <ScorecardMetric
              label="Proposal spend"
              value={formatMoneyCents(proposal.spentCents)}
              detail="hypothetical ledger cost"
            />
            <ScorecardMetric
              label="Proposal return"
              value={formatMoneyCents(proposal.wonCents)}
              detail={`${formatMoneyCents(proposal.nonCashValueCents)} noncash · ${integerFormatter.format(proposal.pendingPrizeCount)} payouts pending`}
              tone={proposal.wonCents > proposal.spentCents ? "positive" : undefined}
            />
            <ScorecardMetric
              label="Proposal cash ROI"
              value={roi(proposal.roiPercent)}
              detail={`economic ROI ${roi(proposal.economicRoiPercent)} · longest miss run ${integerFormatter.format(proposal.longestLosingStreak)}`}
              tone={(proposal.roiPercent ?? 0) < 0 ? "negative" : "positive"}
            />
            <ScorecardMetric
              label="Confirmed tickets"
              value={integerFormatter.format(confirmed.gradedTickets)}
              detail={`${integerFormatter.format(confirmed.tickets)} purchased total`}
            />
            <ScorecardMetric
              label="Confirmed spend"
              value={formatMoneyCents(confirmed.spentCents)}
              detail="actual budget events only"
            />
            <ScorecardMetric
              label="Confirmed return"
              value={formatMoneyCents(confirmed.wonCents)}
              detail={`${formatMoneyCents(confirmed.nonCashValueCents)} noncash · ${integerFormatter.format(confirmed.pendingPrizeCount)} payouts pending`}
              tone={confirmed.wonCents > confirmed.spentCents ? "positive" : undefined}
            />
            <ScorecardMetric
              label="Confirmed cash ROI"
              value={roi(confirmed.roiPercent)}
              detail={`economic ROI ${roi(confirmed.economicRoiPercent)} · longest miss run ${integerFormatter.format(confirmed.longestLosingStreak)}`}
              tone={(confirmed.roiPercent ?? 0) < 0 ? "negative" : "positive"}
            />
          </div>

          <section className="lotto-track-compare" aria-labelledby="lotto-compare-title">
            <div className="lotto-panel-head">
              <div>
                <p className="lotto-kicker">SAME-SAMPLE COMPARISON</p>
                <h3 id="lotto-compare-title">Optimizer vs. random baseline</h3>
              </div>
              <Scale size={21} />
            </div>
            <div className="lotto-comparison-grid">
              {comparisons.map((row) => (
                <ComparisonCard key={row.origin} row={row} />
              ))}
            </div>
            <p className="lotto-comparison-method">
              {state.summary.data.comparisonPolicy.description}{" "}
              {integerFormatter.format(state.summary.data.comparisonPolicy.sharedStrata)} shared draw
              {state.summary.data.comparisonPolicy.sharedStrata === 1 ? "" : "s"};{" "}
              {integerFormatter.format(state.summary.data.comparisonPolicy.ticketsPerOrigin)} tickets per origin.
            </p>
            <div className="lotto-track-honesty">
              <CircleAlert size={16} />
              <p>
                <strong>The scoreboard does not smooth losses.</strong> A negative 60% ROI is shown as negative 60%. Random and optimized tickets have the same draw odds; split avoidance matters only after a win. {hasUserComparison ? "Hand-picked plays are included at the same sample scale." : "Hand-picked comparison appears only after those plays are logged."}
              </p>
            </div>
          </section>

          <section className="lotto-track-ledger" aria-labelledby="lotto-ledger-title">
            <div className="lotto-track-ledger-title">
              <div>
                <p className="lotto-kicker">IMMUTABLE HISTORY</p>
                <h3 id="lotto-ledger-title">Every proposed play, graded</h3>
                <span>{integerFormatter.format(resultCount)} tickets visible in this page</span>
              </div>
              <History size={21} />
            </div>

            <form className="lotto-track-filters" onSubmit={applyFilters}>
              <label>
                Game
                <select value={game} onChange={(event) => setGame(event.target.value)}>
                  <option value="">All games</option>
                  {GAME_CODES.map((code) => (
                    <option key={code} value={code}>
                      {GAME_MANIFEST[code].name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                From
                <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
              </label>
              <label>
                To
                <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
              </label>
              <label>
                Result
                <select value={status} onChange={(event) => setStatus(event.target.value)}>
                  <option value="">Every status</option>
                  {(Object.keys(STATUS_LABEL) as TicketLabEntryStatus[]).map((value) => (
                    <option key={value} value={value}>
                      {STATUS_LABEL[value]}
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit">Apply filters</button>
              <button type="button" onClick={clearFilters}>Clear</button>
              {from && to && from > to ? <p role="alert">From date must be on or before To date.</p> : null}
            </form>

            {state.summary.data.prizeTiers.length > 0 ? (
              <div className="lotto-tier-histogram" aria-label="Prize-tier histogram">
                {state.summary.data.prizeTiers.map((tier) => (
                  <div key={tier.tier}>
                    <Trophy size={13} />
                    <span>{tier.tier}</span>
                    <strong>{integerFormatter.format(tier.count)}</strong>
                    <small>{formatMoneyCents(tier.wonCents)}</small>
                  </div>
                ))}
              </div>
            ) : null}

            <div className="lotto-ledger-list">
              {entries.length > 0 ? (
                entries.map((entry) => <LedgerEntryCard key={entry.ledgerId} entry={entry} />)
              ) : (
                <div className="lotto-track-empty">
                  <CheckCircle2 size={22} />
                  <p>No ledger entries match these filters.</p>
                </div>
              )}
            </div>
            {state.entries.data.nextCursor ? (
              <button className="lotto-track-more" type="button" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? <RefreshCw className="lotto-spin" size={13} /> : <History size={13} />}
                {loadingMore ? "Loading…" : "Load older entries"}
              </button>
            ) : null}
          </section>

          <div className="lotto-daily-disclaimer lotto-track-disclaimer">
            <CircleAlert size={15} />
            <p>
              <strong>Optimized, not predicted.</strong> {state.summary.data.disclaimer} Prize amounts marked pending are excluded until an official pari-mutuel settlement is appended.
            </p>
          </div>
        </>
      ) : (
        <div className="lotto-track-gate" aria-live="polite">
          {state.phase === "loading" ? (
            <>
              <RefreshCw className="lotto-spin" size={24} />
              <h3>Reading the immutable ledger</h3>
              <p>Loading scorecards and official-result grades. No ticket is generated here.</p>
            </>
          ) : state.phase === "locked" ? (
            <>
              <LockKeyhole size={24} />
              <h3>Login required</h3>
              <p>
                Ticket history is private. <a href="/">Log in to Yevow</a>, then return to view the ledger.
              </p>
            </>
          ) : (
            <>
              <CircleAlert size={24} />
              <h3>Ticket Lab is temporarily unavailable</h3>
              <p>The dashboard will not invent or cache replacement grades. Retry the ledger service.</p>
            </>
          )}
        </div>
      )}
    </section>
  );
}
