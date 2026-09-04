"use client";

import {
  ArrowUpRight,
  CalendarDays,
  CheckCircle2,
  CircleAlert,
  Clock3,
  FileClock,
  RefreshCw,
  Send
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  formatMoneyCents,
  LottoPicksClientError,
  readLottoDailyPicks,
  type LottoDailyPicksResponse,
  type LottoPersistedGenerationRun,
  type LottoPersistedTicket
} from "@/lib/lotto";

type DailyPicksState =
  | { readonly phase: "locked" }
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly response: LottoDailyPicksResponse }
  | { readonly phase: "unavailable" };

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "long",
  month: "short",
  day: "numeric"
});
const centralDateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short"
});
const percentFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

function displayDate(value: string): string {
  return dateFormatter.format(new Date(`${value}T12:00:00.000Z`));
}

function displayNumber(value: number, digits: boolean): string {
  return digits ? String(value) : String(value).padStart(2, "0");
}

function ticketKey(ticket: LottoPersistedTicket): string {
  return `${ticket.ordinal}:${ticket.main.join("-")}:${ticket.bonus.join("-")}`;
}

function GenerationCard({ run }: { readonly run: LottoPersistedGenerationRun }) {
  const digits = run.game === "p3" || run.game === "d4";
  const slotLabel = run.drawSlot === "morning" ? "Morning draw" : "Draw-day set";
  return (
    <article className="lotto-daily-card" aria-labelledby={`lotto-daily-${run.runId}`}>
      <header className="lotto-daily-card-head">
        <div>
          <span className="lotto-game-code">{run.game.toUpperCase()}</span>
          <h3 id={`lotto-daily-${run.runId}`}>{run.gameName}</h3>
        </div>
        <span className="lotto-daily-slot">
          <CheckCircle2 size={12} /> {slotLabel}
        </span>
      </header>

      <div className="lotto-daily-drawline">
        <span>
          <CalendarDays size={13} /> {displayDate(run.drawDate)}
        </span>
        <span>
          <Clock3 size={13} /> Generated{" "}
          {centralDateTimeFormatter.format(new Date(run.generatedAt))}
        </span>
      </div>

      <dl className="lotto-daily-metrics">
        <div>
          <dt>Pair coverage</dt>
          <dd>{percentFormatter.format(run.coverage.coveragePercent)}%</dd>
          <small>
            {run.coverage.distinctPairs.toLocaleString("en-US")} /{" "}
            {run.coverage.possiblePairs.toLocaleString("en-US")}
          </small>
        </div>
        <div>
          <dt>EV / ticket</dt>
          <dd className={run.ev.netCentsPerTicket < 0 ? "lotto-negative" : undefined}>
            {formatMoneyCents(run.ev.netCentsPerTicket)}
          </dd>
          <small>pre-tax model</small>
        </div>
        <div>
          <dt>Data current through</dt>
          <dd>{run.observedThrough}</dd>
          <small>official archive</small>
        </div>
      </dl>

      <ol className="lotto-daily-tickets" aria-label={`${run.gameName} persisted tickets`}>
        {run.tickets.map((ticket) => (
          <li key={ticketKey(ticket)}>
            <span className="lotto-ticket-index">{String(ticket.ordinal).padStart(2, "0")}</span>
            <div className={digits ? "lotto-balls digits" : "lotto-balls"}>
              {ticket.main.map((value, index) => (
                <span key={`main-${index}-${value}`}>{displayNumber(value, digits)}</span>
              ))}
              {ticket.bonus.length > 0 ? <i aria-hidden="true">+</i> : null}
              {ticket.bonus.map((value, index) => (
                <span className="bonus" key={`bonus-${index}-${value}`}>
                  {displayNumber(value, false)}
                </span>
              ))}
            </div>
            <span className={`lotto-risk lotto-risk-${ticket.splitRiskLevel}`}>
              {digits ? `${ticket.playStyle} · ` : ""}
              {ticket.splitRiskLevel} split risk
            </span>
          </li>
        ))}
      </ol>
      {digits ? (
        <p className="lotto-daily-digit-note">
          Exact/box choice changes cost and EV; no digit is due.
        </p>
      ) : null}

      <details className="lotto-daily-provenance" id={`lotto-generation-${run.runId}`}>
        <summary>
          <FileClock size={13} /> Generation log
        </summary>
        <dl>
          <div>
            <dt>Seed</dt>
            <dd>{run.seed}</dd>
          </div>
          <div>
            <dt>Scheduled</dt>
            <dd>{run.scheduledFor}</dd>
          </div>
          <div>
            <dt>Dataset</dt>
            <dd>{run.datasetDigest}</dd>
          </div>
        </dl>
        <p>{run.ev.assumption}</p>
      </details>

      <footer className="lotto-daily-card-foot">
        <p>
          <CircleAlert size={13} /> {run.disclaimer}
        </p>
        <a
          href={`#lotto-generation-${run.runId}`}
          onClick={() => {
            const details = document.getElementById(
              `lotto-generation-${run.runId}`
            ) as HTMLDetailsElement | null;
            if (details) details.open = true;
          }}
          aria-label={`Open ${run.gameName} generation log`}
        >
          Generation log <ArrowUpRight size={13} />
        </a>
      </footer>
    </article>
  );
}

export default function LottoDailyPicksPanel() {
  const [state, setState] = useState<DailyPicksState>({ phase: "loading" });
  const [requestVersion, setRequestVersion] = useState(0);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 6_000);
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
    void readLottoDailyPicks({ signal: controller.signal, token })
      .then((response) => {
        if (active) setState({ phase: "ready", response });
      })
      .catch((error: unknown) => {
        if (active) {
          setState(
            error instanceof LottoPicksClientError && error.status === 401
              ? { phase: "locked" }
              : { phase: "unavailable" }
          );
        }
      })
      .finally(() => window.clearTimeout(timeout));
    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [requestVersion]);

  const ticketCount = useMemo(
    () =>
      state.phase === "ready"
        ? state.response.data.runs.reduce((total, run) => total + run.tickets.length, 0)
        : 0,
    [state]
  );
  const retry = () => setRequestVersion((version) => version + 1);
  const runs = state.phase === "ready" ? state.response.data.runs : [];

  return (
    <section className="lotto-daily-panel" aria-labelledby="lotto-daily-title">
      <header className="lotto-daily-head">
        <span className="lotto-daily-icon" aria-hidden="true">
          <Send size={19} />
        </span>
        <div>
          <p>AUTONOMOUS DAILY SERVICE</p>
          <h2 id="lotto-daily-title">Today&apos;s optimized picks</h2>
          <span>
            Persisted by the draw-day pipeline—the dashboard and message delivery use the same set.
          </span>
        </div>
        <div className="lotto-daily-actions">
          <span role="status" aria-live="polite">
            {state.phase === "loading" ? (
              <>
                <RefreshCw className="lotto-spin" size={13} /> Loading persisted picks
              </>
            ) : state.phase === "ready" ? (
              <>
                <CheckCircle2 size={13} /> {runs.length} games · {ticketCount} tickets
              </>
            ) : state.phase === "locked" ? (
              <>
                <CircleAlert size={13} /> Login required
              </>
            ) : (
              <>
                <CircleAlert size={13} /> Service unavailable
              </>
            )}
          </span>
          <button type="button" onClick={retry} disabled={state.phase === "loading"}>
            <RefreshCw size={13} /> Refresh picks
          </button>
        </div>
      </header>

      {state.phase === "ready" && runs.length > 0 ? (
        <div className="lotto-daily-grid">
          {runs.map((run) => (
            <GenerationCard key={run.runId} run={run} />
          ))}
        </div>
      ) : (
        <div className="lotto-daily-empty">
          {state.phase === "loading" ? (
            <p>
              The service is reading today&apos;s stored generation runs. Nothing is generated on
              page load.
            </p>
          ) : state.phase === "ready" ? (
            <p>
              No draw-day sets have been published for {displayDate(state.response.data.drawDate)}.
              The scheduler will place selected games here after its pre-draw data check.
            </p>
          ) : state.phase === "locked" ? (
            <p>
              Exact picks stay private to reduce needless sharing.{" "}
              <a href="/">Log in to the Yevow dashboard</a>, then return here to load today&apos;s
              persisted set.
            </p>
          ) : (
            <p>
              Today&apos;s stored picks cannot be reached right now. This page will never substitute
              a newly generated set; retry to preserve dashboard-to-message consistency.
            </p>
          )}
        </div>
      )}

      <div className="lotto-daily-disclaimer">
        <CircleAlert size={15} />
        <p>
          <strong>Optimized, not predicted.</strong> These picks seek broader coverage and less
          familiar selection patterns; they do not improve the odds of any number being drawn. Play
          responsibly.
        </p>
      </div>
    </section>
  );
}
