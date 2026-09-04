"use client";

import {
  ArrowLeft,
  ArrowUpRight,
  BarChart3,
  Calculator,
  CheckCircle2,
  CircleAlert,
  Clover,
  Database,
  Dices,
  FileCheck2,
  Gauge,
  Info,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Target,
  TrendingDown
} from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  AUDIT_SNAPSHOTS,
  GAME_CODES,
  GAME_MANIFEST,
  breakEvenJackpotCents,
  calculateAllEv,
  calculateEv,
  formatMoneyCents,
  type AuditSnapshot,
  type DigitPattern,
  type DigitPlayStyle,
  type EvInput,
  type EvResult,
  type GameCode,
  type GameManifestEntry,
  type PickResult
} from "@/lib/lotto";

type LottoView = "overview" | "audit" | "picker" | "ev";
type AuditedGame = AuditSnapshot["game"];
type PickerWorkerResponse =
  | { readonly ok: true; readonly result: PickResult }
  | { readonly ok: false; readonly error: string };

const VIEWS: ReadonlyArray<{
  id: LottoView;
  label: string;
  icon: typeof BarChart3;
}> = [
  { id: "overview", label: "Overview", icon: Gauge },
  { id: "audit", label: "Audit", icon: BarChart3 },
  { id: "picker", label: "Ticket Lab", icon: Dices },
  { id: "ev", label: "EV Lab", icon: Calculator }
];

const JACKPOT_GAMES = new Set<GameCode>(["lotto", "twostep", "pb", "mm"]);
const AUDITED_GAMES = new Set<GameCode>(["lotto", "cash5"]);
const DAILY4_PAIR_STYLES = new Set<DigitPlayStyle>([
  "front-pair",
  "mid-pair",
  "middle-pair",
  "back-pair"
]);
const OFFICIAL_ARCHIVE_ROWS = 3_791 + 8_846;

const numberFormatter = new Intl.NumberFormat("en-US");
const percentFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 2
});

function matrixLabel(game: GameManifestEntry): string {
  if (game.kind === "digits") {
    return `${game.main.count} digits · ${game.main.min}–${game.main.max}`;
  }
  if (game.bonus) {
    return `${game.main.count}/${game.main.max} + ${game.bonus.count}/${game.bonus.max}`;
  }
  return `${game.main.count}/${game.main.max}`;
}

function shortDate(value: string): string {
  return value.slice(0, 10);
}

function formatPValue(value: number): string {
  if (value < 0.000001) return "< 0.000001";
  return value.toFixed(6);
}

function compactHash(value: string): string {
  return `${value.slice(0, 12)}…${value.slice(-10)}`;
}

function parseNumber(value: string): number | null {
  if (value.trim() === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function parseNonNegativeInteger(value: string): number | null {
  const numeric = parseNumber(value);
  return numeric !== null && Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null;
}

function dollarsToCents(value: string): number | null {
  const numeric = parseNumber(value);
  if (numeric === null || numeric < 0) return null;
  const unroundedCents = numeric * 100;
  const cents = Math.round(unroundedCents);
  return Number.isSafeInteger(cents) && Math.abs(unroundedCents - cents) < 0.000001 ? cents : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The calculation could not be completed.";
}

function normalizedStyleLabel(style: DigitPlayStyle): string {
  return style.replaceAll("-", " ");
}

function factorial(value: number): number {
  let result = 1;
  for (let factor = 2; factor <= value; factor += 1) result *= factor;
  return result;
}

function permutationCount(values: readonly number[]): number {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let denominator = 1;
  for (const count of counts.values()) denominator *= factorial(count);
  return factorial(values.length) / denominator;
}

function riskClass(level: "low" | "moderate" | "high"): string {
  return `lotto-risk lotto-risk-${level}`;
}

export default function LottoPage() {
  const [activeView, setActiveView] = useState<LottoView>("overview");
  const [auditGame, setAuditGame] = useState<AuditedGame>("lotto");

  const [pickerGame, setPickerGame] = useState<GameCode>("lotto");
  const [ticketCount, setTicketCount] = useState("8");
  const [seed, setSeed] = useState("1836");
  const [budget, setBudget] = useState("20.00");
  const [pickerExtra, setPickerExtra] = useState(false);
  const [pickerStakeCents, setPickerStakeCents] = useState<50 | 100 | 200 | 300 | 400 | 500>(50);
  const [pickerStyle, setPickerStyle] = useState<DigitPlayStyle>("straight");
  const [pickResult, setPickResult] = useState<PickResult | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const [pickBusy, setPickBusy] = useState(false);
  const pickerWorkerRef = useRef<Worker | null>(null);

  const [evGame, setEvGame] = useState<GameCode>("lotto");
  const [jackpotDollars, setJackpotDollars] = useState("5000000");
  const [ticketSales, setTicketSales] = useState("1500000");
  const [popularity, setPopularity] = useState("1.0");
  const [evExtra, setEvExtra] = useState(false);
  const [stakeCents, setStakeCents] = useState<50 | 100 | 200 | 300 | 400 | 500>(100);
  const [evStyle, setEvStyle] = useState<DigitPlayStyle>("straight");
  const [digitPattern, setDigitPattern] = useState<DigitPattern>("abc");
  const [evResult, setEvResult] = useState<EvResult | null>(null);
  const [breakEvenCents, setBreakEvenCents] = useState<number | null>(null);
  const [evError, setEvError] = useState<string | null>(null);

  const baselineRows = useMemo(
    () => [...calculateAllEv()].sort((left, right) => left.returnPercent - right.returnPercent),
    []
  );

  const auditedDraws = Object.values(AUDIT_SNAPSHOTS).reduce(
    (total, snapshot) => total + snapshot.drawsAnalyzed,
    0
  );
  const currentAudit = AUDIT_SNAPSHOTS[auditGame];
  const pickerConfig = GAME_MANIFEST[pickerGame];
  const pickerStyleMultiplier =
    pickerConfig.kind !== "digits"
      ? 1
      : pickerStyle === "straight-box"
        ? 2
        : pickerStyle === "combo"
          ? pickerGame === "p3"
            ? 6
            : 24
          : 1;
  const pickerTicketCost =
    pickerConfig.kind === "digits"
      ? pickerStakeCents * pickerStyleMultiplier
      : pickerConfig.baseCostCents + (pickerGame === "lotto" && pickerExtra ? 100 : 0);
  const requestedTicketCount = parseNonNegativeInteger(ticketCount) ?? 0;
  const actualPickCost = pickResult?.tickets.reduce((total, { ticket }) => {
    if (pickerConfig.kind !== "digits") return total + pickerTicketCost;
    const multiplier =
      pickerStyle === "straight-box"
        ? 2
        : pickerStyle === "combo"
          ? permutationCount(ticket.main)
          : 1;
    return total + pickerStakeCents * multiplier;
  }, 0);
  const requestedTotal = actualPickCost ?? pickerTicketCost * requestedTicketCount;
  const budgetCents = dollarsToCents(budget) ?? 0;
  const maxAffordable = pickerTicketCost > 0 ? Math.floor(budgetCents / pickerTicketCost) : 0;

  useEffect(
    () => () => {
      pickerWorkerRef.current?.terminate();
    },
    []
  );

  function selectView(view: LottoView) {
    setActiveView(view);
    window.requestAnimationFrame(() => {
      document
        .querySelector(".lotto-view-tabs")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  function invalidatePickResult() {
    pickerWorkerRef.current?.terminate();
    pickerWorkerRef.current = null;
    setPickBusy(false);
    setPickResult(null);
    setPickError(null);
  }

  function invalidateEvResult() {
    setEvResult(null);
    setBreakEvenCents(null);
    setEvError(null);
  }

  function handleGenerate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPickError(null);
    setPickResult(null);

    if (
      !Number.isInteger(requestedTicketCount) ||
      requestedTicketCount < 1 ||
      requestedTicketCount > 200
    ) {
      setPickError("Ticket count must be a whole number from 1 to 200.");
      return;
    }
    const minimumUnitCost =
      pickerConfig.kind === "digits" && pickerStyle === "combo"
        ? pickerStakeCents * (pickerGame === "p3" ? 3 : 4)
        : pickerTicketCost;
    if (budgetCents < minimumUnitCost) {
      setPickError(`Budget must cover at least one ${formatMoneyCents(minimumUnitCost)} play.`);
      return;
    }
    if (pickerStyle !== "combo" && requestedTotal > budgetCents) {
      setPickError(
        `${requestedTicketCount} plays cost ${formatMoneyCents(requestedTotal)}. This budget covers ${maxAffordable}.`
      );
      return;
    }

    try {
      pickerWorkerRef.current?.terminate();
      const worker = new Worker(new URL("../../workers/lotto-picker.worker.ts", import.meta.url), {
        type: "module",
        name: "rabbitholetx-picker"
      });
      pickerWorkerRef.current = worker;
      setPickBusy(true);

      worker.onmessage = (message: MessageEvent<PickerWorkerResponse>) => {
        if (pickerWorkerRef.current !== worker) return;
        worker.terminate();
        pickerWorkerRef.current = null;
        setPickBusy(false);
        if (!message.data.ok) {
          setPickError(message.data.error);
          return;
        }
        const result = message.data.result;
        const resultCost = result.tickets.reduce((total, { ticket }) => {
          const multiplier =
            pickerStyle === "combo"
              ? permutationCount(ticket.main)
              : pickerStyle === "straight-box"
                ? 2
                : 1;
          return (
            total +
            (pickerConfig.kind === "digits" ? pickerStakeCents * multiplier : pickerTicketCost)
          );
        }, 0);
        if (resultCost > budgetCents) {
          setPickError(
            `This seeded ${normalizedStyleLabel(pickerStyle)} set costs ${formatMoneyCents(resultCost)}. Reduce the count or stake to stay inside budget.`
          );
          return;
        }
        setPickResult(result);
      };
      worker.onerror = () => {
        if (pickerWorkerRef.current !== worker) return;
        worker.terminate();
        pickerWorkerRef.current = null;
        setPickBusy(false);
        setPickError("The local optimization worker failed. Try again or reduce the ticket count.");
      };
      worker.postMessage({
        game: pickerGame,
        count: requestedTicketCount,
        seed: seed.trim() || "yevow-lotto",
        playStyle: pickerConfig.kind === "digits" ? pickerStyle : "straight"
      });
    } catch (error) {
      pickerWorkerRef.current = null;
      setPickBusy(false);
      setPickError(errorMessage(error));
    }
  }

  function handleCalculateEv(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setEvError(null);
    setEvResult(null);
    setBreakEvenCents(null);

    const sales = parseNonNegativeInteger(ticketSales);
    const popularityMultiplier = parseNumber(popularity);
    const jackpotCents = dollarsToCents(jackpotDollars);
    if (sales === null || sales > 1_000_000_000_000) {
      setEvError("Ticket sales must be a non-negative whole number of plays, not sales dollars.");
      return;
    }
    if (popularityMultiplier === null || popularityMultiplier < 0 || popularityMultiplier > 100) {
      setEvError("Popularity multiplier must be a number from 0 to 100.");
      return;
    }
    if (
      JACKPOT_GAMES.has(evGame) &&
      (jackpotCents === null || jackpotCents > 100_000_000_000_000)
    ) {
      setEvError("Cash jackpot must be a non-negative USD amount with no more than two decimals.");
      return;
    }

    const input: EvInput = {
      game: evGame,
      ...(GAME_MANIFEST[evGame].kind !== "digits"
        ? { ticketSales: sales, popularityMultiplier }
        : {}),
      ...(JACKPOT_GAMES.has(evGame) ? { jackpotCents: jackpotCents! } : {}),
      ...(evGame === "lotto" ? { extra: evExtra } : {}),
      ...(GAME_MANIFEST[evGame].kind === "digits"
        ? {
            stakeCents,
            playStyle: evStyle,
            ...(DAILY4_PAIR_STYLES.has(evStyle) ? {} : { digitPattern })
          }
        : {})
    };

    try {
      setEvResult(calculateEv(input));
      if (JACKPOT_GAMES.has(evGame)) {
        setBreakEvenCents(breakEvenJackpotCents(input));
      }
    } catch (error) {
      setEvError(errorMessage(error));
    }
  }

  function changePickerGame(game: GameCode) {
    invalidatePickResult();
    setPickerGame(game);
    setPickerStyle("straight");
    setPickerStakeCents(50);
    setPickerExtra(false);
  }

  function changeEvGame(game: GameCode) {
    setEvGame(game);
    setEvStyle("straight");
    setDigitPattern(game === "d4" ? "abcd" : "abc");
    setEvExtra(false);
    setEvResult(null);
    setBreakEvenCents(null);
    setEvError(null);
  }

  return (
    <main className="lotto-shell">
      <header className="lotto-topbar">
        <a className="lotto-back" href="/" aria-label="Back to Yevow dashboard">
          <ArrowLeft size={16} />
          <span>YEWOW</span>
        </a>
        <div className="lotto-wordmark" aria-label="Yevow LOTTO">
          <span className="lotto-wordmark-mark">
            <Clover size={17} />
          </span>
          <h2>LOTTO</h2>
          <small>RabbitHoleTX</small>
        </div>
        <div className="lotto-top-status">
          <span>
            <span className="lotto-live-dot" /> RULES VERIFIED 2026-09-03
          </span>
          <span>OFFICIAL EXPORT EVIDENCE</span>
        </div>
      </header>

      <section className="lotto-hero" aria-labelledby="lotto-title">
        <div className="lotto-hero-copy">
          <p className="lotto-kicker">
            <span>OPERATION LONE STAR</span> / FORENSIC LOTTERY LAB
          </p>
          <h1 id="lotto-title">
            Better math.
            <br />
            <em>Fewer shared jackpots.</em>
          </h1>
          <p className="lotto-hero-lede">
            Audit the drawings, build lower-collision ticket sets, and price the bet honestly. Every
            result is reproducible. Nothing here claims to predict a random draw.
          </p>
          <div className="lotto-hero-actions">
            <button className="lotto-primary-action" onClick={() => selectView("picker")}>
              <Dices size={17} /> Build a ticket set
            </button>
            <button className="lotto-secondary-action" onClick={() => selectView("audit")}>
              <FileCheck2 size={17} /> Inspect the audit
            </button>
          </div>
        </div>

        <aside className="lotto-hero-card" aria-label="Mission boundary">
          <div className="lotto-orbit" aria-hidden="true">
            <span>54</span>
            <span>35</span>
            <span>24</span>
            <span>69</span>
            <span>10</span>
            <Clover size={38} />
          </div>
          <div className="lotto-warning-lockup">
            <CircleAlert size={18} />
            <div>
              <strong>NOT A PREDICTION</strong>
              <p>
                Past draws cannot make a number “due.” Optimization only targets coverage and likely
                split behavior.
              </p>
            </div>
          </div>
        </aside>
      </section>

      <section className="lotto-proof-strip" aria-label="Dataset status">
        <div>
          <Database size={17} />
          <span>
            <strong>{numberFormatter.format(OFFICIAL_ARCHIVE_ROWS)}</strong> official archive rows
            verified
          </span>
        </div>
        <div>
          <ShieldCheck size={17} />
          <span>
            <strong>{numberFormatter.format(auditedDraws)}</strong> current-era draws audited
          </span>
        </div>
        <div>
          <CheckCircle2 size={17} />
          <span>
            <strong>2</strong> published audit snapshots
          </span>
        </div>
        <div>
          <LockKeyhole size={17} />
          <span>
            <strong>0</strong> personal ticket data stored
          </span>
        </div>
      </section>

      <nav className="lotto-view-tabs" role="tablist" aria-label="LOTTO sections">
        {VIEWS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            id={`lotto-tab-${id}`}
            className={activeView === id ? "active" : ""}
            role="tab"
            aria-selected={activeView === id}
            aria-controls={`lotto-panel-${id}`}
            onClick={() => selectView(id)}
          >
            <Icon size={16} /> {label}
          </button>
        ))}
      </nav>

      <div className="lotto-workspace">
        {activeView === "overview" ? (
          <section id="lotto-panel-overview" role="tabpanel" aria-labelledby="lotto-tab-overview">
            <div className="lotto-section-heading">
              <div>
                <p className="lotto-kicker">CURRENT TEXAS MATRICES</p>
                <h2>Eight games. Zero superstition.</h2>
              </div>
              <p>
                Rules, costs, schedules, and odds are versioned. Historical audit claims appear only
                where official data has been verified.
              </p>
            </div>

            <div className="lotto-game-grid">
              {GAME_CODES.map((code) => {
                const game = GAME_MANIFEST[code];
                const audited = AUDITED_GAMES.has(code);
                return (
                  <article className="lotto-game-card" key={code}>
                    <div className="lotto-game-card-head">
                      <span className="lotto-game-code">{code.toUpperCase()}</span>
                      <span className={audited ? "lotto-data-badge verified" : "lotto-data-badge"}>
                        {audited ? "AUDIT VERIFIED" : "RULES VERIFIED"}
                      </span>
                    </div>
                    <h3>{game.name}</h3>
                    <p className="lotto-matrix">{matrixLabel(game)}</p>
                    <dl className="lotto-game-facts">
                      <div>
                        <dt>Base play</dt>
                        <dd>{formatMoneyCents(game.baseCostCents)}</dd>
                      </div>
                      <div>
                        <dt>Top odds</dt>
                        <dd>1 in {numberFormatter.format(game.topPrizeOdds)}</dd>
                      </div>
                      <div>
                        <dt>Draws</dt>
                        <dd>{game.schedule}</dd>
                      </div>
                    </dl>
                    <div className="lotto-card-actions">
                      <button
                        onClick={() => {
                          changePickerGame(code);
                          selectView("picker");
                        }}
                      >
                        Optimize
                      </button>
                      <button
                        onClick={() => {
                          changeEvGame(code);
                          selectView("ev");
                        }}
                      >
                        Price EV
                      </button>
                      <a
                        href={game.officialPage}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={`${game.name} official rules`}
                      >
                        Official <ArrowUpRight size={13} />
                      </a>
                    </div>
                  </article>
                );
              })}
            </div>

            <section className="lotto-panel lotto-ev-ranking" aria-labelledby="baseline-heading">
              <div className="lotto-panel-head">
                <div>
                  <p className="lotto-kicker">BASELINE RETURN MODEL</p>
                  <h3 id="baseline-heading">Worst → least-worst</h3>
                </div>
                <span className="lotto-data-badge">JACKPOTS SET TO $0</span>
              </div>
              <div className="lotto-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Rank</th>
                      <th>Game / play</th>
                      <th>Cost</th>
                      <th>Gross EV</th>
                      <th>Net EV</th>
                      <th>Expected return</th>
                    </tr>
                  </thead>
                  <tbody>
                    {baselineRows.map((row, index) => (
                      <tr key={`${row.game}-${row.ticketCostCents}`}>
                        <td>{String(index + 1).padStart(2, "0")}</td>
                        <td>
                          <strong>{row.gameName}</strong>
                          <small>{row.game.toUpperCase()}</small>
                        </td>
                        <td>{formatMoneyCents(row.ticketCostCents)}</td>
                        <td>{formatMoneyCents(row.grossEvCents)}</td>
                        <td className="lotto-negative">{formatMoneyCents(row.netEvCents)}</td>
                        <td>
                          <span className="lotto-return-bar">
                            <i
                              style={{ width: `${Math.max(0, Math.min(100, row.returnPercent))}%` }}
                            />
                          </span>
                          {percentFormatter.format(row.returnPercent)}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="lotto-footnote">
                This comparison intentionally excludes jackpot value so fixed lower-tier economics
                remain visible. Use EV Lab with a pre-tax cash jackpot and estimated play count for
                a draw-specific model.
              </p>
              <div className="lotto-honest-answer">
                <CircleAlert size={17} />
                <p>
                  <strong>Can a Texas game ever be +EV?</strong> None of these zero-jackpot base
                  plays is positive before tax. Fixed-prize games stay negative under current
                  payouts. A rollover game can cross its mathematical break-even only when the cash
                  jackpot is large enough after expected splits—then taxes and real-world
                  assumptions still matter.
                </p>
              </div>
            </section>
          </section>
        ) : null}

        {activeView === "audit" ? (
          <AuditPanel snapshot={currentAudit} selected={auditGame} onSelect={setAuditGame} />
        ) : null}

        {activeView === "picker" ? (
          <section id="lotto-panel-picker" role="tabpanel" aria-labelledby="lotto-tab-picker">
            <div className="lotto-section-heading">
              <div>
                <p className="lotto-kicker">SPLIT-AVOIDANCE OPTIMIZER</p>
                <h2>Coverage over folklore.</h2>
              </div>
              <p>
                Seeded candidate search penalizes birthdays, sequences, visual grids, same-decade
                clusters, and popular “lucky” numbers. It cannot improve draw odds.
              </p>
            </div>

            <div className="lotto-lab-grid">
              <form className="lotto-panel lotto-control-panel" onSubmit={handleGenerate}>
                <div className="lotto-panel-head">
                  <div>
                    <p className="lotto-kicker">INPUTS</p>
                    <h3>Build constraints</h3>
                  </div>
                  <Target size={21} />
                </div>
                <label>
                  Game
                  <select
                    value={pickerGame}
                    onChange={(event) => changePickerGame(event.target.value as GameCode)}
                  >
                    {GAME_CODES.map((code) => (
                      <option key={code} value={code}>
                        {GAME_MANIFEST[code].name}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="lotto-form-row">
                  <label>
                    Tickets
                    <input
                      type="number"
                      min="1"
                      max="200"
                      step="1"
                      value={ticketCount}
                      onChange={(event) => {
                        setTicketCount(event.target.value);
                        invalidatePickResult();
                      }}
                    />
                  </label>
                  <label>
                    Seed
                    <input
                      type="text"
                      maxLength={80}
                      value={seed}
                      onChange={(event) => {
                        setSeed(event.target.value);
                        invalidatePickResult();
                      }}
                      spellCheck={false}
                    />
                  </label>
                </div>
                <label>
                  Hard budget (USD)
                  <input
                    type="number"
                    min="0"
                    max="10000"
                    step="0.50"
                    value={budget}
                    onChange={(event) => {
                      setBudget(event.target.value);
                      invalidatePickResult();
                    }}
                  />
                </label>

                {pickerConfig.kind === "digits" ? (
                  <div className="lotto-form-row">
                    <label>
                      Base stake
                      <select
                        value={pickerStakeCents}
                        onChange={(event) => {
                          setPickerStakeCents(
                            Number(event.target.value) as typeof pickerStakeCents
                          );
                          invalidatePickResult();
                        }}
                      >
                        {[50, 100, 200, 300, 400, 500].map((cents) => (
                          <option key={cents} value={cents}>
                            {formatMoneyCents(cents)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Ticket play style
                      <select
                        value={pickerStyle}
                        onChange={(event) => {
                          setPickerStyle(event.target.value as DigitPlayStyle);
                          invalidatePickResult();
                        }}
                      >
                        <option value="straight">Straight / exact order</option>
                        <option value="box">Box / any order</option>
                        <option value="straight-box">Straight + box</option>
                        <option value="combo">Combo</option>
                      </select>
                    </label>
                  </div>
                ) : null}

                {pickerGame === "lotto" ? (
                  <label className="lotto-check-row">
                    <input
                      type="checkbox"
                      checked={pickerExtra}
                      onChange={(event) => {
                        setPickerExtra(event.target.checked);
                        invalidatePickResult();
                      }}
                    />
                    Add EXTRA! (+$1 per play; jackpot unchanged)
                  </label>
                ) : null}

                <div className="lotto-budget-meter" aria-live="polite">
                  <div>
                    <span>
                      {pickerConfig.kind === "digits" && pickerStyle === "combo" && !pickResult
                        ? "Maximum spend"
                        : "Planned spend"}
                    </span>
                    <strong>{formatMoneyCents(requestedTotal)}</strong>
                  </div>
                  <div>
                    <span>
                      {pickerStyle === "combo" ? "Conservative capacity" : "Budget capacity"}
                    </span>
                    <strong>{Math.max(0, maxAffordable)} plays</strong>
                  </div>
                  <span className="lotto-meter-track">
                    <i
                      className={requestedTotal > budgetCents ? "over" : ""}
                      style={{
                        width: `${budgetCents > 0 ? Math.min(100, (requestedTotal / budgetCents) * 100) : 100}%`
                      }}
                    />
                  </span>
                </div>

                <button
                  className="lotto-primary-action lotto-submit"
                  type="submit"
                  disabled={pickBusy}
                >
                  {pickBusy ? (
                    <RefreshCw className="lotto-spin" size={17} />
                  ) : (
                    <Sparkles size={17} />
                  )}
                  {pickBusy ? "Optimizing in background…" : "Generate optimized set"}
                </button>
                {pickError ? (
                  <p className="lotto-form-error" role="alert">
                    <CircleAlert size={15} />
                    {pickError}
                  </p>
                ) : null}
                <p className="lotto-privacy-note">
                  <LockKeyhole size={14} /> Runs locally in your browser. Tickets are not stored or
                  transmitted.
                </p>
              </form>

              <section
                className="lotto-panel lotto-results-panel"
                aria-live="polite"
                aria-busy={pickBusy}
              >
                {pickResult ? (
                  <>
                    <div className="lotto-results-head">
                      <div>
                        <p className="lotto-kicker">OPTIMIZED SET</p>
                        <h3>{GAME_MANIFEST[pickResult.game].name}</h3>
                      </div>
                      <span>SEED / {String(pickResult.seed)}</span>
                    </div>
                    <div className="lotto-result-metrics">
                      <div>
                        <span>Pair coverage</span>
                        <strong>
                          {percentFormatter.format(pickResult.coverage.coveragePercent)}%
                        </strong>
                        <small>
                          {numberFormatter.format(pickResult.coverage.distinctPairs)} /{" "}
                          {numberFormatter.format(pickResult.coverage.possiblePairs)} pairs
                        </small>
                      </div>
                      <div>
                        <span>Average split risk</span>
                        <strong>{pickResult.averageSplitRisk.toFixed(1)}</strong>
                        <small>lower is less conventional</small>
                      </div>
                      <div>
                        <span>Set cost</span>
                        <strong>{formatMoneyCents(actualPickCost ?? requestedTotal)}</strong>
                        <small>{pickResult.tickets.length} valid plays</small>
                      </div>
                    </div>
                    <ol className="lotto-ticket-list" aria-label="Optimized tickets">
                      {pickResult.tickets.map(({ ticket, splitRisk }, index) => (
                        <li
                          className="lotto-ticket"
                          key={`${index}-${ticket.main.join("-")}-${ticket.bonus?.join("-") ?? ""}`}
                        >
                          <span className="lotto-ticket-index">
                            {String(index + 1).padStart(2, "0")}
                          </span>
                          <div
                            className={
                              ticket.game === "p3" || ticket.game === "d4"
                                ? "lotto-balls digits"
                                : "lotto-balls"
                            }
                          >
                            {ticket.main.map((value, ballIndex) => (
                              <span key={`${ballIndex}-${value}`}>{value}</span>
                            ))}
                            {ticket.bonus?.length ? <i>+</i> : null}
                            {ticket.bonus?.map((value, ballIndex) => (
                              <span className="bonus" key={`bonus-${ballIndex}-${value}`}>
                                {value}
                              </span>
                            ))}
                          </div>
                          <div className="lotto-ticket-risk-block">
                            <span className={riskClass(splitRisk.level)}>
                              {splitRisk.level} split risk
                            </span>
                            <details className="lotto-risk-details">
                              <summary>Risk factors</summary>
                              <ul>
                                {splitRisk.notes.length ? (
                                  splitRisk.notes.map((note) => <li key={note}>{note}</li>)
                                ) : (
                                  <li>No penalized familiar-pick pattern was detected.</li>
                                )}
                              </ul>
                            </details>
                          </div>
                        </li>
                      ))}
                    </ol>
                    <div className="lotto-note-stack">
                      {pickResult.notes.map((note) => (
                        <p key={note}>
                          <Info size={14} />
                          {note}
                        </p>
                      ))}
                      {pickerGame === "lotto" && pickerExtra ? (
                        <p>
                          <Info size={14} />
                          EXTRA! changes lower-tier payouts and ticket cost—not the selected numbers
                          or jackpot.
                        </p>
                      ) : null}
                    </div>
                  </>
                ) : (
                  <div className="lotto-empty-state">
                    <div className="lotto-empty-icon">
                      <Dices size={34} />
                    </div>
                    <h3>Your optimized set appears here</h3>
                    <p>
                      Choose a legal budget, a reproducible seed, and the number of tickets. The
                      engine maximizes distinct pair coverage while seeking less commonly chosen
                      shapes.
                    </p>
                    <div className="lotto-empty-proof">
                      <CheckCircle2 size={15} /> Every output is validated against the current game
                      matrix.
                    </div>
                  </div>
                )}
              </section>
            </div>

            {pickerConfig.kind === "digits" ? (
              <aside className="lotto-disclaimer compact">
                <CircleAlert size={18} />
                <p>
                  <strong>No digit is due.</strong> Straight/exact and box/any-order are different
                  bets with different odds, costs, and payouts. The picker’s split-risk score is
                  descriptive—not a probability advantage.
                </p>
              </aside>
            ) : null}
          </section>
        ) : null}

        {activeView === "ev" ? (
          <section id="lotto-panel-ev" role="tabpanel" aria-labelledby="lotto-tab-ev">
            <div className="lotto-section-heading">
              <div>
                <p className="lotto-kicker">EXPECTED-VALUE LAB</p>
                <h2>Price the bet. Include the crowd.</h2>
              </div>
              <p>
                Jackpot EV uses the pre-tax cash value, estimated play volume, and your
                combination’s popularity to model pari-mutuel splitting.
              </p>
            </div>

            <div className="lotto-lab-grid">
              <form className="lotto-panel lotto-control-panel" onSubmit={handleCalculateEv}>
                <div className="lotto-panel-head">
                  <div>
                    <p className="lotto-kicker">ASSUMPTIONS</p>
                    <h3>Draw economics</h3>
                  </div>
                  <Calculator size={21} />
                </div>
                <label>
                  Game
                  <select
                    value={evGame}
                    onChange={(event) => changeEvGame(event.target.value as GameCode)}
                  >
                    {GAME_CODES.map((code) => (
                      <option key={code} value={code}>
                        {GAME_MANIFEST[code].name}
                      </option>
                    ))}
                  </select>
                </label>
                {JACKPOT_GAMES.has(evGame) ? (
                  <label>
                    Pre-tax cash jackpot (USD)
                    <input
                      type="number"
                      min="0"
                      max="1000000000000"
                      step="0.01"
                      value={jackpotDollars}
                      onChange={(event) => {
                        setJackpotDollars(event.target.value);
                        invalidateEvResult();
                      }}
                    />
                    <small>Do not enter the advertised annuity.</small>
                  </label>
                ) : null}
                {GAME_MANIFEST[evGame].kind !== "digits" ? (
                  <div className="lotto-form-row">
                    <label>
                      Estimated ticket sales (plays)
                      <input
                        type="number"
                        min="0"
                        max="1000000000000"
                        step="1"
                        value={ticketSales}
                        onChange={(event) => {
                          setTicketSales(event.target.value);
                          invalidateEvResult();
                        }}
                      />
                      <small>
                        {evGame === "pb" || evGame === "mm"
                          ? "Use plays across all participating jurisdictions, including this play."
                          : "Use estimated Texas plays, including this play."}
                      </small>
                    </label>
                    <label>
                      Pick popularity multiplier
                      <input
                        type="number"
                        min="0"
                        max="100"
                        step="0.05"
                        value={popularity}
                        onChange={(event) => {
                          setPopularity(event.target.value);
                          invalidateEvResult();
                        }}
                      />
                      <small>1.0 = random pick; below 1 = less popular.</small>
                    </label>
                  </div>
                ) : null}

                {evGame === "lotto" ? (
                  <label className="lotto-check-row">
                    <input
                      type="checkbox"
                      checked={evExtra}
                      onChange={(event) => {
                        setEvExtra(event.target.checked);
                        invalidateEvResult();
                      }}
                    />
                    Include EXTRA! (+$1; jackpot unchanged)
                  </label>
                ) : null}

                {GAME_MANIFEST[evGame].kind === "digits" ? (
                  <>
                    <div className="lotto-form-row">
                      <label>
                        Base stake
                        <select
                          value={stakeCents}
                          onChange={(event) => {
                            setStakeCents(Number(event.target.value) as typeof stakeCents);
                            invalidateEvResult();
                          }}
                        >
                          {[50, 100, 200, 300, 400, 500].map((cents) => (
                            <option key={cents} value={cents}>
                              {formatMoneyCents(cents)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Play style
                        <select
                          value={evStyle}
                          onChange={(event) => {
                            const nextStyle = event.target.value as DigitPlayStyle;
                            setEvStyle(nextStyle);
                            invalidateEvResult();
                            if (
                              nextStyle !== "straight" &&
                              (digitPattern === "aaa" || digitPattern === "aaaa")
                            ) {
                              setDigitPattern(evGame === "p3" ? "abc" : "abcd");
                            }
                          }}
                        >
                          <option value="straight">Straight / exact</option>
                          <option value="box">Box / any order</option>
                          <option value="straight-box">Straight + box</option>
                          <option value="combo">Combo</option>
                          {evGame === "d4" ? (
                            <>
                              <option value="front-pair">Front pair</option>
                              <option value="mid-pair">Middle pair</option>
                              <option value="back-pair">Back pair</option>
                            </>
                          ) : null}
                        </select>
                      </label>
                    </div>
                    {!DAILY4_PAIR_STYLES.has(evStyle) ? (
                      <label>
                        Digit pattern
                        <select
                          value={digitPattern}
                          onChange={(event) => {
                            setDigitPattern(event.target.value as DigitPattern);
                            invalidateEvResult();
                          }}
                        >
                          {evGame === "p3" ? (
                            <>
                              <option value="abc">ABC · all different</option>
                              <option value="aab">AAB · one pair</option>
                              <option value="aaa" disabled={evStyle !== "straight"}>
                                AAA · all same
                              </option>
                            </>
                          ) : (
                            <>
                              <option value="abcd">ABCD · all different</option>
                              <option value="aabc">AABC · one pair</option>
                              <option value="aabb">AABB · two pairs</option>
                              <option value="aaab">AAAB · three alike</option>
                              <option value="aaaa" disabled={evStyle !== "straight"}>
                                AAAA · all same
                              </option>
                            </>
                          )}
                        </select>
                      </label>
                    ) : null}
                  </>
                ) : null}

                <button className="lotto-primary-action lotto-submit" type="submit">
                  <Calculator size={17} /> Calculate EV
                </button>
                {evError ? (
                  <p className="lotto-form-error" role="alert">
                    <CircleAlert size={15} />
                    {evError}
                  </p>
                ) : null}
                <p className="lotto-privacy-note">
                  <Info size={14} /> Taxes are excluded. Dollar inputs use integer cents; displayed
                  expectations round to cents.
                </p>
              </form>

              <section className="lotto-panel lotto-results-panel" aria-live="polite">
                {evResult ? (
                  <>
                    <div className="lotto-results-head">
                      <div>
                        <p className="lotto-kicker">MODEL OUTPUT</p>
                        <h3>{evResult.gameName}</h3>
                      </div>
                      <span>COST / {formatMoneyCents(evResult.ticketCostCents)}</span>
                    </div>
                    <div className="lotto-ev-hero-metrics">
                      <div className="lotto-ev-return">
                        <span>Expected return</span>
                        <strong>{percentFormatter.format(evResult.returnPercent)}%</strong>
                        <small>
                          {formatMoneyCents(evResult.evPerTwoDollarsCents)} net EV per $2
                        </small>
                      </div>
                      <div>
                        <span>Gross EV</span>
                        <strong>{formatMoneyCents(evResult.grossEvCents)}</strong>
                      </div>
                      <div>
                        <span>Net EV</span>
                        <strong
                          className={evResult.netEvCents < 0 ? "lotto-negative" : "lotto-positive"}
                        >
                          {formatMoneyCents(evResult.netEvCents)}
                        </strong>
                      </div>
                      <div>
                        <span>Expected jackpot share</span>
                        <strong>
                          {percentFormatter.format(evResult.expectedJackpotShare * 100)}%
                        </strong>
                      </div>
                    </div>
                    {breakEvenCents !== null ? (
                      <div className="lotto-break-even">
                        <TrendingDown size={17} />
                        <span>Modeled break-even cash jackpot</span>
                        <strong>{formatMoneyCents(breakEvenCents)}</strong>
                      </div>
                    ) : null}
                    <div className="lotto-table-wrap lotto-tier-table">
                      <table>
                        <thead>
                          <tr>
                            <th>Prize tier</th>
                            <th>Probability</th>
                            <th>Adjusted prize</th>
                            <th>EV contribution</th>
                            <th>Type</th>
                          </tr>
                        </thead>
                        <tbody>
                          {evResult.tiers.map((tier) => (
                            <tr key={tier.tier}>
                              <td>
                                <strong>{tier.tier}</strong>
                              </td>
                              <td>
                                1 in {numberFormatter.format(Math.round(1 / tier.probability))}
                              </td>
                              <td>{formatMoneyCents(tier.adjustedPrizeCents)}</td>
                              <td>{formatMoneyCents(tier.expectedValueCents)}</td>
                              <td>
                                <small>{tier.prizeKind}</small>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <details className="lotto-method-details">
                      <summary>Model assumptions</summary>
                      {evResult.assumptions.map((assumption) => (
                        <p key={assumption}>{assumption}</p>
                      ))}
                    </details>
                  </>
                ) : (
                  <div className="lotto-empty-state">
                    <div className="lotto-empty-icon">
                      <Calculator size={34} />
                    </div>
                    <h3>EV is an assumption, not a headline</h3>
                    <p>
                      Enter cash value and play volume. Lower-popularity number patterns can reduce
                      the expected split, but never change the probability of winning.
                    </p>
                    <div className="lotto-empty-proof">
                      <CheckCircle2 size={15} /> Every prize probability comes from exact
                      current-matrix combinatorics.
                    </div>
                  </div>
                )}
              </section>
            </div>
          </section>
        ) : null}
      </div>

      <section className="lotto-disclaimer" aria-label="Responsible play disclaimer">
        <ShieldCheck size={23} />
        <p>
          <strong>Forensic analysis, not financial advice.</strong> Lottery draws are random;
          historical frequencies do not predict future results. Split avoidance can change how much
          a rare win might retain, never the chance of winning. Set a hard entertainment budget and
          never chase losses.
        </p>
      </section>

      <footer className="lotto-footer">
        <div>
          <Clover size={15} />
          <strong>LOTTO</strong>
          <span>Analysis engine: RabbitHoleTX</span>
        </div>
        <p>
          Independent analysis. Not affiliated with or endorsed by the Texas Lottery Commission.
        </p>
      </footer>
    </main>
  );
}

function AuditPanel({
  snapshot,
  selected,
  onSelect
}: {
  snapshot: AuditSnapshot;
  selected: AuditedGame;
  onSelect: (game: AuditedGame) => void;
}) {
  const sortedFrequencies = [...snapshot.frequencies].sort(
    (a, b) => b.deviationPercent - a.deviationPercent
  );
  const hottest = sortedFrequencies.slice(0, 6);
  const coldest = [...snapshot.frequencies]
    .sort((a, b) => a.deviationPercent - b.deviationPercent)
    .slice(0, 6);

  return (
    <section id="lotto-panel-audit" role="tabpanel" aria-labelledby="lotto-tab-audit">
      <div className="lotto-section-heading">
        <div>
          <p className="lotto-kicker">DRAW INTEGRITY AUDIT</p>
          <h2>Test the machine, not your hunch.</h2>
        </div>
        <p>
          Family-wise error is controlled across multiple tests. “No flag” means the observed
          deviation did not cross the corrected threshold—not that randomness has been proven.
        </p>
      </div>

      <label className="lotto-audit-select">
        <span>Audit game</span>
        <select value={selected} onChange={(event) => onSelect(event.target.value as AuditedGame)}>
          <option value="lotto">Lotto Texas</option>
          <option value="cash5">Cash Five</option>
        </select>
      </label>

      <section className="lotto-audit-banner">
        <div className="lotto-audit-seal">
          <FileCheck2 size={27} />
          <span>VERIFIED</span>
        </div>
        <div>
          <p className="lotto-kicker">VERIFIED OFFICIAL ARCHIVE / CURRENT MATRIX ERA</p>
          <h3>{GAME_MANIFEST[selected].name}</h3>
          <p>
            {numberFormatter.format(snapshot.drawsAnalyzed)} draws analyzed from{" "}
            {snapshot.observedFrom} through {snapshot.observedThrough}
          </p>
        </div>
        <dl>
          <div>
            <dt>Era rows</dt>
            <dd>{numberFormatter.format(snapshot.source.recordsRepresented)}</dd>
          </div>
          <div>
            <dt>Family α</dt>
            <dd>{snapshot.familyWiseAlpha}</dd>
          </div>
          <div>
            <dt>Corrected threshold</dt>
            <dd>{snapshot.bonferroniThreshold.toFixed(6)}</dd>
          </div>
        </dl>
      </section>

      <div className="lotto-finding-grid">
        {snapshot.findings.map((finding) => (
          <article
            className={`lotto-finding ${finding.verdict === "FLAG" ? "flag" : ""}`}
            key={finding.name}
          >
            <div>
              <span>{finding.verdict}</span>
              {finding.verdict === "NO FLAG" ? (
                <CheckCircle2 size={17} />
              ) : (
                <CircleAlert size={17} />
              )}
            </div>
            <h3>{finding.name}</h3>
            <dl>
              <div>
                <dt>Statistic</dt>
                <dd>{finding.statistic.toFixed(4)}</dd>
              </div>
              <div>
                <dt>p-value</dt>
                <dd>{formatPValue(finding.pValue)}</dd>
              </div>
            </dl>
            <p>{finding.detail}</p>
          </article>
        ))}
      </div>

      <div className="lotto-audit-detail-grid">
        <section className="lotto-panel">
          <div className="lotto-panel-head">
            <div>
              <p className="lotto-kicker">DESCRIPTIVE ONLY</p>
              <h3>Frequency extremes</h3>
            </div>
            <BarChart3 size={20} />
          </div>
          <div className="lotto-frequency-columns">
            <div>
              <h4>Above expectation</h4>
              {hottest.map((row) => (
                <div className="lotto-frequency-row" key={`hot-${row.value}`}>
                  <span>{row.value}</span>
                  <i>
                    <b
                      style={{
                        width: `${Math.min(100, 50 + Math.max(0, row.deviationPercent) * 2)}%`
                      }}
                    />
                  </i>
                  <strong>+{row.deviationPercent.toFixed(1)}%</strong>
                </div>
              ))}
            </div>
            <div>
              <h4>Below expectation</h4>
              {coldest.map((row) => (
                <div className="lotto-frequency-row cold" key={`cold-${row.value}`}>
                  <span>{row.value}</span>
                  <i>
                    <b
                      style={{
                        width: `${Math.min(100, 50 + Math.abs(Math.min(0, row.deviationPercent)) * 2)}%`
                      }}
                    />
                  </i>
                  <strong>{row.deviationPercent.toFixed(1)}%</strong>
                </div>
              ))}
            </div>
          </div>
          <p className="lotto-footnote">
            These are retrospective counts, not “hot” or “due” recommendations.
          </p>
        </section>

        <section className="lotto-panel">
          <div className="lotto-panel-head">
            <div>
              <p className="lotto-kicker">CO-OCCURRENCE</p>
              <h3>Most observed groups</h3>
            </div>
            <Target size={20} />
          </div>
          <div className="lotto-combo-columns">
            <div>
              <h4>Pairs</h4>
              {snapshot.topPairs.slice(0, 7).map((combo) => (
                <div key={combo.values.join("-")}>
                  <span>{combo.values.join(" · ")}</span>
                  <strong>{combo.count}</strong>
                </div>
              ))}
            </div>
            <div>
              <h4>Triplets</h4>
              {snapshot.topTriplets.slice(0, 7).map((combo) => (
                <div key={combo.values.join("-")}>
                  <span>{combo.values.join(" · ")}</span>
                  <strong>{combo.count}</strong>
                </div>
              ))}
            </div>
          </div>
          <p className="lotto-footnote">
            High historical co-occurrence does not raise future joint probability.
          </p>
        </section>

        <section className="lotto-panel lotto-gap-panel">
          <div className="lotto-panel-head">
            <div>
              <p className="lotto-kicker">GAP ANALYSIS</p>
              <h3>Current waiting times</h3>
            </div>
            <RefreshCw size={20} />
          </div>
          <div className="lotto-gap-list">
            {[...snapshot.gaps]
              .sort((a, b) => b.currentGap - a.currentGap)
              .slice(0, 10)
              .map((gap) => (
                <div key={gap.value}>
                  <span className="lotto-mini-ball">{gap.value}</span>
                  <span>
                    Current <strong>{gap.currentGap}</strong>
                  </span>
                  <span>
                    Historical mean <strong>{gap.meanCompletedGap.toFixed(1)}</strong>
                  </span>
                </div>
              ))}
          </div>
          <p className="lotto-footnote">
            A long gap is not evidence that a ball is due; independent drawings have no memory.
          </p>
        </section>
      </div>

      <section className="lotto-provenance">
        <div>
          <Database size={18} />
          <span>
            <strong>Source provenance</strong> {shortDate(snapshot.generatedAt)} report · era begins{" "}
            {snapshot.eraStart}
          </span>
        </div>
        <code title={snapshot.source.sha256}>SHA-256 {compactHash(snapshot.source.sha256)}</code>
        <div className="lotto-provenance-links">
          <a href={`/lotto/reports/${selected}-audit.md`} download>
            Markdown report <FileCheck2 size={13} />
          </a>
          <a href={snapshot.source.url} target="_blank" rel="noreferrer">
            Official export <ArrowUpRight size={13} />
          </a>
        </div>
      </section>

      <details className="lotto-method-details lotto-panel">
        <summary>Method, limits, and interpretation</summary>
        {snapshot.notes.map((note) => (
          <p key={note}>{note}</p>
        ))}
        <p>{snapshot.disclaimer}</p>
      </details>
    </section>
  );
}
