"use client";

import { CircleAlert, FlaskConical, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { formatMoneyCents } from "@/lib/lotto/ev";
import { GAME_MANIFEST } from "@/lib/lotto/manifest";
import {
  readChallengers,
  type ChallengerResponse,
  type ShadowScorecard
} from "@/lib/lotto/challenger-client";
import { LottoTicketLabClientError, type TicketLabFilters } from "@/lib/lotto/ticket-lab-client";

type State =
  | { phase: "loading" | "locked" | "unavailable" }
  | { phase: "ready"; response: ChallengerResponse };

function Comparison({ label, score }: { readonly label: string; readonly score: ShadowScorecard }) {
  const net = score.wonCents - score.spentCents;
  return (
    <article className="lotto-comparison-card" aria-label={label}>
      <header>
        <span>{label}</span>
        <strong
          className={score.roiPercent !== null && score.roiPercent < 0 ? "lotto-negative" : ""}
        >
          {score.roiPercent === null
            ? "Not final"
            : `${score.roiPercent > 0 ? "+" : ""}${score.roiPercent.toFixed(1)}%`}{" "}
          cash ROI
        </strong>
      </header>
      <dl>
        <div>
          <dt>Matched sample</dt>
          <dd>
            {score.gradedDraws} draws · {score.gradedTickets} tickets
          </dd>
        </div>
        <div>
          <dt>Graded paper cost</dt>
          <dd>{formatMoneyCents(score.spentCents)}</dd>
        </div>
        <div>
          <dt>Known cash return</dt>
          <dd>{formatMoneyCents(score.wonCents)}</dd>
        </div>
        <div>
          <dt>Known paper net</dt>
          <dd>
            {formatMoneyCents(net)}
            {score.pendingPrizeCount > 0 ? " (lower bound)" : ""}
          </dd>
        </div>
        <div>
          <dt>Noncash face value</dt>
          <dd>{formatMoneyCents(score.nonCashValueCents)} — not cash</dd>
        </div>
        <div>
          <dt>Payouts pending</dt>
          <dd>{score.pendingPrizeCount}</dd>
        </div>
      </dl>
    </article>
  );
}

/** Isolated paper-only results. Viewing never starts a trial or changes live picks. */
export default function LottoChallengerPanel({
  filters = {},
  refreshVersion = 0
}: {
  readonly filters?: Pick<TicketLabFilters, "game" | "from" | "to">;
  readonly refreshVersion?: number;
}) {
  const [state, setState] = useState<State>({ phase: "loading" });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const token = window.localStorage.getItem("sovereign.jwt")?.trim() ?? "";
    if (!token) {
      setState({ phase: "locked" });
      return () => {
        active = false;
        controller.abort();
      };
    }
    const timeout = window.setTimeout(() => controller.abort(), 8_000);
    setState({ phase: "loading" });
    void readChallengers(
      { game: filters.game, from: filters.from, to: filters.to },
      { token, signal: controller.signal }
    )
      .then((response) => {
        if (active) setState({ phase: "ready", response });
      })
      .catch((error: unknown) => {
        if (active)
          setState({
            phase:
              error instanceof LottoTicketLabClientError && error.status === 401
                ? "locked"
                : "unavailable"
          });
      })
      .finally(() => window.clearTimeout(timeout));
    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [filters.game, filters.from, filters.to, refreshVersion, retry]);

  return (
    <section className="lotto-track-compare" aria-labelledby="lotto-challenger-title">
      <div className="lotto-panel-head">
        <div>
          <p className="lotto-kicker">FUTURE HOLDOUT · PAPER ONLY</p>
          <h3 id="lotto-challenger-title">Challenger trials</h3>
        </div>
        <FlaskConical size={21} />
      </div>
      <div className="lotto-track-honesty">
        <CircleAlert size={16} />
        <p>
          <strong>Separate experiments, not betting recommendations.</strong> Challenger tickets
          never enter live ROI, purchase tracking, or SMS picks. Goals and versions are frozen
          before future draws. No automatic promotion, no forecasts, and no claim of improved
          expected value. Picks are optimized, not predicted.
        </p>
      </div>
      {state.phase === "ready" ? (
        <>
          <p className="lotto-comparison-method">
            {state.response.data.policy.description} Matched by game, draw date, session, ticket
            count, wager, and play style. Review gate: {state.response.data.policy.reviewDate}; a
            review is not permission to promote a variant.
          </p>
          {state.response.data.variants.length === 0 ||
          state.response.data.variants.every((variant) => variant.draws === 0) ? (
            <div className="lotto-track-empty" role="status">
              <FlaskConical size={22} />
              <p>
                No forward trial results yet. Historical winning days are not reused as validation
                data.
              </p>
            </div>
          ) : null}
          {state.response.data.variants.map((variant) => (
            <section key={variant.id} aria-label={`${variant.label} trial`}>
              <div className="lotto-panel-head">
                <div>
                  <h4>
                    {variant.label} · {variant.version}
                  </h4>
                  <p>Frozen goal: {variant.goal}</p>
                  <p>
                    {variant.status === "armed"
                      ? "Armed for future draws"
                      : "Collecting forward observations"}
                    {" · "}
                    {variant.draws} tracked draws · {variant.gradedDraws} matched graded draws
                  </p>
                </div>
              </div>
              <div className="lotto-comparison-grid">
                <Comparison label="Paper challenger" score={variant} />
                <Comparison label="Current optimizer control" score={variant.comparisons.current} />
                <Comparison label="Uniform random control" score={variant.comparisons.random} />
              </div>
              <p className="lotto-comparison-method">
                Frozen at {variant.frozenAt ?? "first scheduled trial"}; first eligible draw date{" "}
                {variant.firstEligibleDrawDate ?? "not yet recorded"}. Small or volatile samples do
                not establish an edge. Known returns may include modeled Mega Millions multipliers;
                paper payouts do not prove a purchase or a paid claim.
              </p>
            </section>
          ))}
          {state.response.data.latest.length > 0 ? (
            <details className="lotto-ledger-entry-foot">
              <summary>Latest saved challenger tickets and frozen evidence</summary>
              <ol className="lotto-ledger-list" aria-label="Saved challenger trials">
                {state.response.data.latest.map((trial) => (
                  <li key={trial.trialId} className="lotto-ledger-entry">
                    <h4>
                      {GAME_MANIFEST[trial.game].name} · {trial.drawDate} {trial.targetSession}
                    </h4>
                    <p>
                      {trial.variantId} · {trial.status} · proposed {trial.proposedAt}
                    </p>
                    <ol aria-label={`${GAME_MANIFEST[trial.game].name} challenger tickets`}>
                      {trial.tickets.map((ticket, index) => (
                        <li key={index}>
                          {ticket.main
                            .map((number) =>
                              trial.game === "p3" || trial.game === "d4"
                                ? String(number)
                                : String(number).padStart(2, "0")
                            )
                            .join("-")}
                          {ticket.bonus?.length
                            ? ` + ${ticket.bonus.map((number) => String(number).padStart(2, "0")).join("-")}`
                            : ""}
                          {" · "}
                          {ticket.playStyle ?? "straight"}
                        </li>
                      ))}
                    </ol>
                    <p>
                      Seed: {trial.seed} · configuration: {trial.configHash} · data through{" "}
                      {trial.observedThrough ?? "not recorded"}
                    </p>
                    <p>Paper only. Optimized, not predicted.</p>
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
          <p className="lotto-comparison-method">{state.response.data.disclaimer}</p>
        </>
      ) : (
        <div className="lotto-track-empty" aria-live="polite">
          {state.phase === "loading" ? (
            <RefreshCw className="lotto-spin" size={20} />
          ) : (
            <CircleAlert size={20} />
          )}
          <p>
            {state.phase === "loading"
              ? "Reading saved forward trials…"
              : state.phase === "locked"
                ? "Log in to view private challenger trials."
                : "Challenger results unavailable. The live ledger above is unchanged; no replacement results are invented."}
          </p>
          {state.phase === "unavailable" ? (
            <button type="button" onClick={() => setRetry((value) => value + 1)}>
              Retry challenger results
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}
