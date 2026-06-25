"use client";

import type { LucideIcon } from "lucide-react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  BadgeCheck,
  BarChart3,
  CircleDot,
  Eye,
  Flame,
  Gauge,
  Gem,
  Heart,
  Landmark,
  Plus,
  PlayCircle,
  RadioTower,
  Rocket,
  Scale,
  Settings,
  Sparkles,
  Star,
  Timer,
  Users,
  WalletCards,
  Zap
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type Side = "yes" | "no";

interface Reaction {
  label: string;
  icon: LucideIcon;
}

interface LivePot {
  label: string;
  host: string;
  yes: number;
  volume: number;
  status: string;
}

interface EngineMetric {
  label: string;
  value: string;
  tone?: "good" | "warn" | "hot";
}

interface DotCastApiSnapshot {
  pool: {
    id: string;
    status: string;
    pools: {
      yes: number;
      no: number;
    };
  };
  entries: Array<{ id: string }>;
  balances: Record<string, { available: number; locked: number }>;
}

interface DotCastApiResponse {
  ok: boolean;
  error?: string;
  created?: boolean;
  snapshot?: DotCastApiSnapshot;
  balance?: {
    available: number;
    locked: number;
  };
}

const reactions: Reaction[] = [
  { label: "Heat", icon: Flame },
  { label: "Launch", icon: Rocket },
  { label: "Gem", icon: Gem },
  { label: "Signal", icon: Sparkles },
  { label: "Applause", icon: Heart }
];

const stakeOptions = [10, 25, 100];

const livePots: LivePot[] = [
  {
    label: "Main pot: host completes the burn sequence",
    host: "Orbital Desk",
    yes: 73,
    volume: 18420,
    status: "Resolving"
  },
  {
    label: "Side pot: guest says the forbidden ticker",
    host: "Macro Room",
    yes: 41,
    volume: 9120,
    status: "Live"
  },
  {
    label: "Flash pot: chat reaches the unlock target",
    host: "Creator Live",
    yes: 58,
    volume: 6680,
    status: "Live"
  }
];

const DOTCAST_API_BASE =
  process.env.NEXT_PUBLIC_DOTCAST_API_BASE ?? "https://api.yevow.co/api/dotcast";
const DEMO_POOL_ID = "dotcast-demo-orbital-v2";
const DEMO_USER_STORAGE_KEY = "dotcast:user-id";

const settlementSteps = [
  "Prompt locked",
  "Entrants matched",
  "Evidence window",
  "Payout queue"
];

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2
});

const compactMoney = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1
});

function payoutPreview(side: Side, stake: number, yesPool: number, noPool: number) {
  if (stake <= 0) {
    return 0;
  }

  const projectedYes = yesPool + (side === "yes" ? stake : 0);
  const projectedNo = noPool + (side === "no" ? stake : 0);
  const winningPool = side === "yes" ? projectedYes : projectedNo;
  const losingPool = side === "yes" ? projectedNo : projectedYes;
  const rakeAdjustedLosingPool = losingPool * 0.95;

  return stake + (stake / winningPool) * rakeAdjustedLosingPool;
}

function formatCountdown(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

async function dotCastApi<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${DOTCAST_API_BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {})
    }
  });
  const payload = (await response.json()) as DotCastApiResponse;

  if (!response.ok || !payload.ok) {
    throw new Error(payload.error ?? "dotCast API request failed");
  }

  return payload as T;
}

function getOrCreateUserId() {
  const existing = window.localStorage.getItem(DEMO_USER_STORAGE_KEY);

  if (existing) {
    return existing;
  }

  const userId = `dotcast-user-${crypto.randomUUID()}`;
  window.localStorage.setItem(DEMO_USER_STORAGE_KEY, userId);
  return userId;
}

export default function DotCastPage() {
  const [selectedSide, setSelectedSide] = useState<Side>("yes");
  const [stake, setStake] = useState(25);
  const [yesPool, setYesPool] = useState(1420);
  const [noPool, setNoPool] = useState(2870);
  const [freeEntries, setFreeEntries] = useState(3);
  const [entryCount, setEntryCount] = useState(286);
  const [secondsLeft, setSecondsLeft] = useState(258);
  const [poolStatus, setPoolStatus] = useState("open");
  const [userId, setUserId] = useState<string | null>(null);
  const [balance, setBalance] = useState<{ available: number; locked: number } | null>(null);
  const [apiStatus, setApiStatus] = useState("Syncing");
  const [apiError, setApiError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const totalPool = yesPool + noPool;
  const yesPct = totalPool > 0 ? Math.round((yesPool / totalPool) * 100) : 50;
  const noPct = 100 - yesPct;
  const projectedWin = useMemo(
    () => payoutPreview(selectedSide, stake, yesPool, noPool),
    [noPool, selectedSide, stake, yesPool]
  );
  const selectedPct = selectedSide === "yes" ? yesPct : noPct;
  const selectedLabel = selectedSide === "yes" ? "Yes" : "No";
  const engineReadouts = useMemo<EngineMetric[]>(
    () => [
      { label: "Matched stake", value: compactMoney.format(totalPool), tone: "good" },
      {
        label: "Reserve cover",
        value: balance ? compactMoney.format(balance.available) : "Pending",
        tone: balance ? "good" : "warn"
      },
      { label: "Pool status", value: poolStatus, tone: poolStatus === "open" ? "good" : "warn" },
      { label: "Router bridge", value: "Ready", tone: "good" }
    ],
    [balance, poolStatus, totalPool]
  );

  useEffect(() => {
    const nextUserId = getOrCreateUserId();
    setUserId(nextUserId);
    void ensureDemoPool(nextUserId);
  }, []);

  function applyApiResponse(payload: DotCastApiResponse, nextStatus = "Pool synced") {
    if (payload.snapshot) {
      setYesPool(payload.snapshot.pool.pools.yes);
      setNoPool(payload.snapshot.pool.pools.no);
      setPoolStatus(payload.snapshot.pool.status);
      setEntryCount(payload.snapshot.entries.length);
      setBalance(payload.balance ?? payload.snapshot.balances[userId ?? ""] ?? null);
    }

    if (payload.balance) {
      setBalance(payload.balance);
    }

    setApiStatus(nextStatus);
    setApiError(null);
  }

  async function ensureDemoPool(nextUserId: string) {
    try {
      const now = new Date().toISOString();
      const payload = await dotCastApi<DotCastApiResponse>("/pools", {
        method: "POST",
        body: JSON.stringify({
          id: DEMO_POOL_ID,
          market: {
            id: "dotcast:orbital-next-call-demo",
            venue: "dotcast",
            question: "Orbital nails the next on-air call?",
            status: "open",
            closeTime: "2099-06-25T17:05:00.000Z",
            expectedResolveAt: "2099-06-25T17:10:00.000Z"
          },
          unit: "points",
          entryOpensAt: now,
          entryClosesAt: "2099-06-25T17:05:00.000Z",
          rake: 0.05,
          minLiquidity: 100,
          now
        })
      });
      let syncedPayload = payload;

      if (payload.snapshot && payload.snapshot.entries.length === 0) {
        await seedDemoEntry("seed-yes", "yes", 1420, now);
        syncedPayload = await seedDemoEntry("seed-no", "no", 2870, now);
      }

      const balancePayload = syncedPayload.snapshot?.balances[nextUserId]
        ? syncedPayload
        : await dotCastApi<DotCastApiResponse>(`/pools/${encodeURIComponent(DEMO_POOL_ID)}`);
      applyApiResponse(balancePayload, "Pool live");
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "Pool sync failed");
      setApiStatus("Pool offline");
    }
  }

  async function seedDemoEntry(entryId: string, side: Side, amount: number, now: string) {
    return dotCastApi<DotCastApiResponse>(`/pools/${encodeURIComponent(DEMO_POOL_ID)}/entries`, {
      method: "POST",
      body: JSON.stringify({
        userId: "dotcast-host-seed",
        side,
        amount,
        entryId,
        now
      })
    });
  }

  async function placeEntry(amount = stake): Promise<boolean> {
    if (amount <= 0) {
      return false;
    }

    if (!userId || isSubmitting || poolStatus !== "open") {
      return false;
    }

    setIsSubmitting(true);

    try {
      const payload = await dotCastApi<DotCastApiResponse>(`/pools/${encodeURIComponent(DEMO_POOL_ID)}/entries`, {
        method: "POST",
        body: JSON.stringify({
          userId,
          side: selectedSide,
          amount,
          now: new Date().toISOString()
        })
      });
      applyApiResponse(payload, "Prediction placed");
      setSecondsLeft((current) => Math.max(45, current - 7));
      return true;
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "Prediction failed");
      return false;
    } finally {
      setIsSubmitting(false);
    }
  }

  async function useFreeEntry() {
    if (freeEntries <= 0) {
      return;
    }

    const placed = await placeEntry(5);

    if (placed) {
      setFreeEntries((current) => Math.max(0, current - 1));
    }
  }

  return (
    <main className="dotcast-shell">
      <aside className="dotcast-rail" aria-label="dotCast sections">
        <a className="dotcast-mark" href="/" aria-label="Back to Yevow">
          d
        </a>
        <button className="dotcast-rail-button active" aria-label="Live">
          <RadioTower size={20} />
        </button>
        <button className="dotcast-rail-button" aria-label="Following">
          <Star size={20} />
        </button>
        <button className="dotcast-rail-button" aria-label="Markets">
          <Scale size={20} />
        </button>
        <button className="dotcast-rail-button" aria-label="Wallet">
          <WalletCards size={20} />
        </button>
        <button className="dotcast-rail-button" aria-label="Analytics">
          <BarChart3 size={20} />
        </button>
        <button className="dotcast-rail-button" aria-label="Clips">
          <PlayCircle size={20} />
        </button>
        <button className="dotcast-rail-button bottom" aria-label="Settings">
          <Settings size={20} />
        </button>
      </aside>

      <section className="dotcast-main">
        <header className="dotcast-topbar">
          <a className="dotcast-back" href="/">
            <ArrowLeft size={18} />
            Back to Yevow
          </a>
          <div className="dotcast-product">
            <span>dotCast</span>
            <strong>Live parimutuel engine</strong>
          </div>
          <div className="dotcast-top-actions">
            <button type="button">
              <Users size={16} />
              Hosts
            </button>
            <button type="button" className="dotcast-primary-action">
              <Plus size={16} />
              Start a pot
            </button>
          </div>
        </header>

        <div className="dotcast-page-grid">
          <div className="dotcast-feed">
            <section className="dotcast-stage" aria-label="Live market stage">
              <div className="dotcast-stage-top">
                <div className="dotcast-live-stack">
                  <span className="dotcast-live-pill">
                    <CircleDot size={13} />
                    Live
                  </span>
                  <span className="dotcast-viewers">
                    <Eye size={17} />
                    12.3K
                  </span>
                </div>
                <div className="dotcast-reactions">
                  {reactions.map((reaction) => {
                    const Icon = reaction.icon;

                    return (
                      <button key={reaction.label} type="button" title={reaction.label} aria-label={reaction.label}>
                        <Icon size={18} />
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="dotcast-orb" aria-label="dotCast live signal">
                dc
              </div>

              <div className="dotcast-market-meta">
                <span>Side pot</span>
                <strong>
                  <Scale size={14} />
                  Community
                </strong>
                <em>
                  <WalletCards size={14} />
                  Host seeded $50
                </em>
                <code>
                  <Timer size={14} />
                  resolves {formatCountdown(secondsLeft)}
                </code>
              </div>

              <h1>Orbital nails the next on-air call?</h1>

              <div className="dotcast-odds-grid" aria-label="Prediction sides">
                <button
                  type="button"
                  className={selectedSide === "yes" ? "dotcast-side selected yes" : "dotcast-side yes"}
                  onClick={() => setSelectedSide("yes")}
                >
                  <ArrowUp size={46} />
                  <strong>Yes {yesPct}%</strong>
                  <span>win {money.format(payoutPreview("yes", stake, yesPool, noPool))}</span>
                </button>
                <button
                  type="button"
                  className={selectedSide === "no" ? "dotcast-side selected no" : "dotcast-side no"}
                  onClick={() => setSelectedSide("no")}
                >
                  <ArrowDown size={46} />
                  <strong>No {noPct}%</strong>
                  <span>win {money.format(payoutPreview("no", stake, yesPool, noPool))}</span>
                </button>
              </div>

              <div className="dotcast-stake-row" aria-label="Stake controls">
                {stakeOptions.map((option) => (
                  <button
                    key={option}
                    type="button"
                    className={stake === option ? "selected" : undefined}
                    onClick={() => setStake(option)}
                  >
                    {money.format(option).replace(".00", "")}
                  </button>
                ))}
                <button type="button" className={stake === 250 ? "selected" : undefined} onClick={() => setStake(250)}>
                  Max
                </button>
                <span className="dotcast-stake-divider" />
                <button type="button" className="dotcast-free-button" disabled={freeEntries === 0 || isSubmitting} onClick={useFreeEntry}>
                  <Zap size={16} />
                  Free x {freeEntries}
                </button>
              </div>

              <div className="dotcast-submit-row">
                <div>
                  <span>{selectedLabel} selected</span>
                  <strong>{selectedPct}% current share</strong>
                  <em>{apiError ?? `${apiStatus} · Projected return ${money.format(projectedWin)}`}</em>
                </div>
                <button
                  type="button"
                  className="dotcast-submit-button"
                  disabled={isSubmitting || poolStatus !== "open"}
                  onClick={() => void placeEntry()}
                >
                  {isSubmitting ? "Placing" : "Place prediction"}
                </button>
              </div>
            </section>

            <section className="dotcast-stream-strip" aria-label="Current stream">
              <div className="dotcast-avatar">dc</div>
              <div>
                <h2>Static fire recap: orbital window this quarter?</h2>
                <p>
                  Orbital Desk <BadgeCheck size={16} /> @orbital-live · Tech
                </p>
              </div>
              <button type="button">
                <Plus size={18} />
                Follow
              </button>
            </section>

            <section className="dotcast-pots-panel" aria-label="Live pots">
              <div className="dotcast-section-heading">
                <div>
                  <span>
                    <CircleDot size={14} />
                    Live pots
                  </span>
                  <strong>4 running</strong>
                </div>
                <button type="button">
                  <Plus size={16} />
                  Start a pot
                </button>
              </div>
              <div className="dotcast-pot-list">
                {livePots.map((pot) => (
                  <article key={pot.label} className="dotcast-pot-row">
                    <div>
                      <strong>{pot.label}</strong>
                      <span>{pot.host}</span>
                    </div>
                    <code>{pot.yes}% yes</code>
                    <code>{compactMoney.format(pot.volume)}</code>
                    <em>{pot.status}</em>
                  </article>
                ))}
              </div>
            </section>
          </div>

          <aside className="dotcast-engine-panel" aria-label="Engine room">
            <section className="dotcast-engine-header">
              <span>
                <Gauge size={16} />
                Engine room
              </span>
              <strong>{entryCount} entries</strong>
            </section>

            <div className="dotcast-engine-metrics">
              {engineReadouts.map((metric) => (
                <div key={metric.label} className={metric.tone ? `dotcast-engine-metric ${metric.tone}` : "dotcast-engine-metric"}>
                  <span>{metric.label}</span>
                  <strong>{metric.value}</strong>
                </div>
              ))}
            </div>

            <section className="dotcast-liability">
              <div>
                <span>Total pool</span>
                <strong>{compactMoney.format(totalPool)}</strong>
              </div>
              <div>
                <span>Yes liability</span>
                <strong>{compactMoney.format(yesPool)}</strong>
              </div>
              <div>
                <span>No liability</span>
                <strong>{compactMoney.format(noPool)}</strong>
              </div>
            </section>

            <section className="dotcast-settlement">
              <div className="dotcast-section-heading compact">
                <div>
                  <span>
                    <Landmark size={14} />
                    Settlement
                  </span>
                  <strong>Evidence mode</strong>
                </div>
              </div>
              <ol>
                {settlementSteps.map((step, index) => (
                  <li key={step} className={index < 2 ? "complete" : undefined}>
                    <span>{index + 1}</span>
                    {step}
                  </li>
                ))}
              </ol>
            </section>

            <section className="dotcast-host-console">
              <div>
                <span>Host seed</span>
                <strong>$50 locked</strong>
              </div>
              <div>
                <span>Risk cap</span>
                <strong>$2.5K</strong>
              </div>
              <button type="button">
                <Flame size={16} />
                Boost pot
              </button>
              <button type="button">
                <Scale size={16} />
                Review rules
              </button>
            </section>
          </aside>
        </div>
      </section>
    </main>
  );
}
