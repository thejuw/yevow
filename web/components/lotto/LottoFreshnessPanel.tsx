"use client";

import { CheckCircle2, CircleAlert, Cloud, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { readLottoStatus, type LottoFreshness, type LottoStatusResponse } from "@/lib/lotto";

type FreshnessState =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly response: LottoStatusResponse }
  | { readonly phase: "fallback" };

const numberFormatter = new Intl.NumberFormat("en-US");
const centralDateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "America/Chicago"
});

function latestValue(values: readonly (string | null)[]): string | null {
  let latest: string | null = null;
  let latestTime = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (value === null) continue;
    const time = Date.parse(value);
    if (time > latestTime) {
      latest = value;
      latestTime = time;
    }
  }
  return latest;
}

function freshnessLabel(status: LottoFreshness): string {
  if (status === "fresh") return "Fresh";
  if (status === "stale") return "Stale";
  return "Unavailable";
}

export default function LottoFreshnessPanel() {
  const [state, setState] = useState<FreshnessState>({ phase: "loading" });
  const [requestVersion, setRequestVersion] = useState(0);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 6_000);
    setState({ phase: "loading" });

    void readLottoStatus({ signal: controller.signal })
      .then((response) => {
        if (active) setState({ phase: "ready", response });
      })
      .catch(() => {
        if (active) setState({ phase: "fallback" });
      })
      .finally(() => window.clearTimeout(timeout));

    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [requestVersion]);

  const summary = useMemo(() => {
    if (state.phase !== "ready") return null;
    const games = state.response.data.games;
    const sourceCount = games.reduce((total, game) => total + game.sourceCount, 0);
    const readySources = games.reduce((total, game) => total + game.readySources, 0);
    const activeDraws = games.reduce((total, game) => total + game.activeDraws, 0);
    const observedThrough = latestValue(games.map((game) => game.observedThrough));
    const lastSuccessAt = latestValue(games.map((game) => game.lastSuccessAt));
    const allFresh =
      games.length > 0 &&
      games.every((game) => game.status === "fresh") &&
      sourceCount === readySources;
    const tone: LottoFreshness = allFresh ? "fresh" : readySources > 0 ? "stale" : "unavailable";
    const label = allFresh
      ? "Cloud archive fresh"
      : readySources > 0
        ? "Cloud archive partially ready"
        : "Cloud archive initializing";
    return {
      games,
      sourceCount,
      readySources,
      activeDraws,
      observedThrough,
      lastSuccessAt,
      tone,
      label
    };
  }, [state]);

  const retry = () => setRequestVersion((version) => version + 1);

  return (
    <section
      className={`lotto-freshness-panel ${summary ? `is-${summary.tone}` : `is-${state.phase}`}`}
      aria-labelledby="lotto-freshness-title"
    >
      <header className="lotto-freshness-head">
        <span className="lotto-freshness-icon" aria-hidden="true">
          <Cloud size={19} />
        </span>
        <div>
          <p>LIVE DATA PLANE</p>
          <h2 id="lotto-freshness-title">Archive freshness</h2>
          <span>Read-only status from the isolated RabbitHoleTX cloud archive.</span>
        </div>
        <div className="lotto-freshness-actions">
          <span className="lotto-freshness-state" role="status" aria-live="polite">
            {state.phase === "loading" ? (
              <>
                <RefreshCw className="lotto-spin" size={13} /> Checking live archive
              </>
            ) : summary ? (
              <>
                {summary.tone === "fresh" ? <CheckCircle2 size={13} /> : <CircleAlert size={13} />}
                {summary.label}
              </>
            ) : (
              <>
                <CircleAlert size={13} /> Embedded snapshot mode
              </>
            )}
          </span>
          <button type="button" onClick={retry} disabled={state.phase === "loading"}>
            <RefreshCw size={13} /> Refresh status
          </button>
        </div>
      </header>

      {state.phase === "ready" && summary ? (
        <>
          <dl className="lotto-freshness-metrics">
            <div>
              <dt>Active draws</dt>
              <dd>{numberFormatter.format(summary.activeDraws)}</dd>
            </div>
            <div>
              <dt>Sources ready</dt>
              <dd>
                {summary.readySources}/{summary.sourceCount}
              </dd>
            </div>
            <div>
              <dt>Observed through</dt>
              <dd>{summary.observedThrough ?? "Awaiting first ingest"}</dd>
            </div>
            <div>
              <dt>Last successful ingest</dt>
              <dd>
                {summary.lastSuccessAt
                  ? centralDateTimeFormatter.format(new Date(summary.lastSuccessAt))
                  : "Awaiting first ingest"}
              </dd>
            </div>
          </dl>

          <ul className="lotto-freshness-games" aria-label="Live archive freshness by game">
            {summary.games.map((game) => (
              <li key={game.code}>
                <span>
                  <strong>{game.name}</strong>
                  <small>
                    {numberFormatter.format(game.activeDraws)} draws · {game.readySources}/
                    {game.sourceCount} sources
                  </small>
                </span>
                <span className={`lotto-freshness-badge is-${game.status}`}>
                  {freshnessLabel(game.status)}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <div className="lotto-freshness-message">
          {state.phase === "loading" ? (
            <p>
              Contacting the live archive. The verified bundled audits, Ticket Lab, and EV Lab
              remain available while this check runs.
            </p>
          ) : (
            <p>
              Live freshness is temporarily unavailable. The verified bundled audits, Ticket Lab,
              and EV Lab remain fully usable; no ticket or form data was sent.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
