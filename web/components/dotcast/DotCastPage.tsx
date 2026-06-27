"use client";

import {
  Archive,
  BadgeCheck,
  Banknote,
  BellRing,
  Bot,
  CircleDot,
  ClipboardList,
  Coins,
  Eye,
  EyeOff,
  Flame,
  Gauge,
  KeyRound,
  Landmark,
  Link as LinkIcon,
  ListChecks,
  MonitorPlay,
  Pause,
  Play,
  Radio,
  RefreshCcw,
  ShieldCheck,
  Square,
  Trophy,
  Users,
  Video,
  WalletCards,
  Zap
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DEFAULT_API_BASE,
  applyDotCastResolverAdminAction,
  attachDotCastLivestreamPool,
  createDotCastLivestream,
  readDotCastCreatorEconomyStatus,
  readDotCastHealth,
  readDotCastLivestream,
  readDotCastLivestreamPlayback,
  readDotCastReferralStatus,
  readDotCastResolutionReviewQueue,
  readDotCastResolutionReviews,
  readDotCastResolutionRouterStatus,
  readDotCastRewardedStreamStatus,
  readDotCastSettlementRailStatus,
  readDotCastSponsoredQuestionsStatus,
  updateDotCastLivestreamState
} from "@/lib/api";
import type {
  DotCastGenericStatusResponse,
  DotCastHealthResponse,
  DotCastLivestreamCreateResponse,
  DotCastLivestreamReadResponse,
  DotCastResolutionReview,
  DotCastResolutionRoute,
  DotCastResolutionRouterStatusResponse,
  DotCastSettlementRailStatusResponse,
  JsonRecord
} from "@/lib/types";

export type DotCastView = "operator" | "studio" | "live" | "resolution";

type LoadState = "LOADING" | "READY" | "ERROR";

interface DotCastPageProps {
  view: DotCastView;
}

interface StatusBundle {
  health: DotCastHealthResponse | null;
  rail: DotCastSettlementRailStatusResponse | null;
  rewarded: DotCastGenericStatusResponse | null;
  sponsored: DotCastGenericStatusResponse | null;
  creator: DotCastGenericStatusResponse | null;
  referrals: DotCastGenericStatusResponse | null;
  resolution: DotCastResolutionRouterStatusResponse | null;
}

const milestoneOrder = [
  "e0",
  "e1",
  "e2",
  "e3",
  "e4",
  "e5",
  "e6",
  "e7",
  "e8",
  "e9",
  "e10",
  "e11",
  "e12",
  "e13"
] as const;

const milestoneLabels: Record<(typeof milestoneOrder)[number], string> = {
  e0: "Parimutuel core",
  e1: "Pool lifecycle",
  e2: "Resolution polling",
  e3: "Live odds",
  e4: "Void/refund",
  e5: "Solana USDC rail",
  e6: "USDC pool funding",
  e7: "Audit ledger",
  e8: "Gamification",
  e9: "Rewarded-stream",
  e10: "Sponsored questions",
  e11: "Creator economy",
  e12: "Referrals",
  e13: "Resolution router"
};

const viewLinks: Array<{ view: DotCastView; href: string; label: string; icon: JSX.Element }> = [
  { view: "operator", href: "/dotcast", label: "Overview", icon: <Gauge size={15} /> },
  { view: "studio", href: "/dotcast/studio", label: "Studio", icon: <Video size={15} /> },
  { view: "live", href: "/dotcast/live", label: "Live Room", icon: <MonitorPlay size={15} /> },
  {
    view: "resolution",
    href: "/dotcast/resolution",
    label: "Resolution",
    icon: <ClipboardList size={15} />
  }
];

const samplePots = [
  {
    poolId: "dotcast:demo:orbital-call",
    question: "Orbital nails the next on-air call?",
    yes: 33,
    no: 67,
    resolves: "04:18"
  },
  {
    poolId: "dotcast:demo:static-fire",
    question: "Static fire recap names the orbital window?",
    yes: 73,
    no: 27,
    resolves: "11:40"
  },
  {
    poolId: "dotcast:demo:host-streak",
    question: "Host starts a second side pot before break?",
    yes: 48,
    no: 52,
    resolves: "19:05"
  }
];

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0
});

const compact = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2
});

export default function DotCastPage({ view }: DotCastPageProps) {
  const [apiBase, setApiBase] = useState(DEFAULT_API_BASE);
  const [loadState, setLoadState] = useState<LoadState>("LOADING");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusBundle>({
    health: null,
    rail: null,
    rewarded: null,
    sponsored: null,
    creator: null,
    referrals: null,
    resolution: null
  });
  const [queue, setQueue] = useState<DotCastResolutionRoute[]>([]);
  const [reviews, setReviews] = useState<DotCastResolutionReview[]>([]);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoadState("LOADING");
    setError(null);

    try {
      const [
        health,
        rail,
        rewarded,
        sponsored,
        creator,
        referrals,
        resolution,
        reviewQueue,
        reviewList
      ] = await Promise.all([
        readDotCastHealth(apiBase),
        readDotCastSettlementRailStatus(apiBase),
        readDotCastRewardedStreamStatus(apiBase),
        readDotCastSponsoredQuestionsStatus(apiBase),
        readDotCastCreatorEconomyStatus(apiBase),
        readDotCastReferralStatus(apiBase),
        readDotCastResolutionRouterStatus(apiBase),
        readDotCastResolutionReviewQueue(apiBase, 8),
        readDotCastResolutionReviews(apiBase, 8)
      ]);

      setStatus({ health, rail, rewarded, sponsored, creator, referrals, resolution });
      setQueue(reviewQueue.resolutionRouter?.routes ?? []);
      setReviews(reviewList.resolutionRouter?.reviews ?? []);
      setLastUpdated(new Date().toISOString());
      setLoadState("READY");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "dotCast API unavailable.");
      setLoadState("ERROR");
    }
  }, [apiBase]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const readyCount = useMemo(() => {
    const milestones = status.health?.milestones ?? {};
    return milestoneOrder.filter((key) => Boolean(milestones[key])).length;
  }, [status.health]);

  const routes = status.health?.routes ?? [];
  const e13RouteCount = routes.filter((route) => route.includes("resolution-router")).length;
  const livestreamRouteCount = routes.filter((route) => route.includes("livestreams")).length;

  return (
    <main className="dotcast-shell">
      <section className="dotcast-hero glass">
        <div className="brand-lockup">
          <div className="sigil dotcast-sigil">
            <Radio size={22} />
          </div>
          <div>
            <h1>dotCast</h1>
            <p>Live parimutuel engine on Yevow</p>
          </div>
        </div>
        <div className="dotcast-top-actions">
          <label className="dotcast-api-label">
            API
            <input
              value={apiBase}
              onChange={(event) => setApiBase(event.target.value)}
              aria-label="dotCast API base"
            />
          </label>
          <button className="compact-action" onClick={() => void refresh()}>
            <RefreshCcw size={14} />
            Refresh
          </button>
        </div>
      </section>

      <nav className="dotcast-tabs glass" aria-label="dotCast views">
        {viewLinks.map((link) => (
          <a className={link.view === view ? "active" : ""} href={link.href} key={link.view}>
            {link.icon}
            {link.label}
          </a>
        ))}
        <a href="/">
          <Landmark size={15} />
          Yevow
        </a>
      </nav>

      <section className="dotcast-safety-strip glass">
        <SafetyPill
          label="E0-E13"
          value={`${readyCount}/14`}
          tone={readyCount === milestoneOrder.length ? "green" : "amber"}
          icon={<ListChecks size={15} />}
        />
        <SafetyPill
          label="USDC"
          value={`${status.rail?.rail?.cluster ?? "devnet"} / ${status.rail?.rail?.signerMode ?? "mock"}`}
          tone="blue"
          icon={<Coins size={15} />}
        />
        <SafetyPill
          label="Withdrawals"
          value={status.rail?.rail?.operatorWithdrawalsApproved ? "operator approved" : "blocked"}
          tone={status.rail?.rail?.operatorWithdrawalsApproved ? "green" : "red"}
          icon={<ShieldCheck size={15} />}
        />
        <SafetyPill
          label="Mux + Livewire"
          value={status.health?.livestream?.ready ? "ready" : "guarded"}
          tone={status.health?.livestream?.ready ? "green" : "amber"}
          icon={<Video size={15} />}
        />
        <SafetyPill
          label="E13 Queue"
          value={`${queue.length} loaded`}
          tone={queue.length > 0 ? "amber" : "green"}
          icon={<ClipboardList size={15} />}
        />
      </section>

      {error ? <div className="dotcast-alert glass">{error}</div> : null}

      {view === "operator" ? (
        <OperatorConsole
          status={status}
          queue={queue}
          reviews={reviews}
          readyCount={readyCount}
          e13RouteCount={e13RouteCount}
          livestreamRouteCount={livestreamRouteCount}
          loadState={loadState}
          lastUpdated={lastUpdated}
        />
      ) : null}

      {view === "studio" ? (
        <HostStudio apiBase={apiBase} queue={queue} onRefresh={() => void refresh()} />
      ) : null}

      {view === "live" ? (
        <ViewerLiveRoom apiBase={apiBase} status={status} onRefresh={() => void refresh()} />
      ) : null}

      {view === "resolution" ? (
        <ResolutionDashboard
          apiBase={apiBase}
          queue={queue}
          reviews={reviews}
          status={status}
          onRefresh={() => void refresh()}
        />
      ) : null}
    </main>
  );
}

function OperatorConsole({
  status,
  queue,
  reviews,
  readyCount,
  e13RouteCount,
  livestreamRouteCount,
  loadState,
  lastUpdated
}: {
  status: StatusBundle;
  queue: DotCastResolutionRoute[];
  reviews: DotCastResolutionReview[];
  readyCount: number;
  e13RouteCount: number;
  livestreamRouteCount: number;
  loadState: LoadState;
  lastUpdated: string | null;
}) {
  const readinessCards = [
    {
      label: "Settlement Rail",
      value: status.rail?.rail?.operational ? "Operational" : "Guarded",
      detail: `${status.rail?.rail?.cluster ?? "devnet"} / ${status.rail?.rail?.signerMode ?? "mock"}`,
      icon: <WalletCards size={18} />
    },
    {
      label: "Livestream Plane",
      value: status.health?.livestream?.ready ? "Ready" : "Guarded",
      detail: `${String(status.health?.livestream?.provider ?? "mux")} + ${String(
        status.health?.livestream?.controlLayer ?? "livewire"
      )}`,
      icon: <MonitorPlay size={18} />
    },
    {
      label: "Rewarded Stream",
      value: status.health?.rewardedStream?.ready ? "Ready" : "Guarded",
      detail: `${String(status.health?.rewardedStream?.requiredCompletions ?? 3)} completions`,
      icon: <Trophy size={18} />
    },
    {
      label: "Resolution Router",
      value: status.health?.resolutionRouter?.ready ? "Ready" : "Guarded",
      detail: `${e13RouteCount} E13 routes`,
      icon: <ClipboardList size={18} />
    }
  ];

  return (
    <>
      <section className="dotcast-operator-grid">
        <div className="dotcast-command-panel glass">
          <div className="dotcast-panel-title">
            <Gauge size={17} />
            Operator Console
            <code>{loadState}</code>
          </div>
          <div className="dotcast-kpi-grid">
            <MetricCard label="Milestones" value={`${readyCount}/14`} detail="E0-E13 online" />
            <MetricCard
              label="API Routes"
              value={String(status.health?.routes?.length ?? 0)}
              detail={`${livestreamRouteCount} livestream`}
            />
            <MetricCard label="Review Queue" value={String(queue.length)} detail="E13 candidates" />
            <MetricCard label="Reviews" value={String(reviews.length)} detail="latest decisions" />
          </div>
          <div className="dotcast-status-grid">
            {readinessCards.map((card) => (
              <ReadinessCard {...card} key={card.label} />
            ))}
          </div>
          <div className="dotcast-timestamp">
            <CircleDot size={12} />
            {lastUpdated ? formatTime(lastUpdated) : "Awaiting first refresh"}
          </div>
        </div>

        <div className="dotcast-command-panel glass">
          <div className="dotcast-panel-title">
            <ShieldCheck size={17} />
            Safety State
          </div>
          <div className="dotcast-guard-list">
            <GuardRow
              label="Network"
              value={status.rail?.rail?.network ?? "solana-devnet"}
              tone="blue"
            />
            <GuardRow label="Signer" value={status.rail?.rail?.signerMode ?? "mock"} tone="amber" />
            <GuardRow
              label="Mainnet withdrawals"
              value={status.rail?.rail?.operatorWithdrawalsApproved ? "approved" : "blocked"}
              tone={status.rail?.rail?.operatorWithdrawalsApproved ? "green" : "red"}
            />
            <GuardRow
              label="Mux token"
              value={status.health?.livestream?.tokenConfigured ? "configured" : "not configured"}
              tone={status.health?.livestream?.tokenConfigured ? "green" : "amber"}
            />
          </div>
        </div>
      </section>

      <section className="dotcast-milestones glass">
        <div className="dotcast-panel-title">
          <ListChecks size={17} />
          E0-E13 Build Map
        </div>
        <div className="dotcast-milestone-grid">
          {milestoneOrder.map((key) => (
            <div className="dotcast-milestone" key={key}>
              <strong>{key.toUpperCase()}</strong>
              <span>{milestoneLabels[key]}</span>
              <code>{status.health?.milestones?.[key] ?? "pending"}</code>
            </div>
          ))}
        </div>
      </section>

      <section className="dotcast-two-column">
        <QueuePanel queue={queue} />
        <ReviewsPanel reviews={reviews} />
      </section>
    </>
  );
}

function HostStudio({
  apiBase,
  queue,
  onRefresh
}: {
  apiBase: string;
  queue: DotCastResolutionRoute[];
  onRefresh: () => void;
}) {
  const [streamId, setStreamId] = useState(`dotcast-studio-${Date.now()}`);
  const [hostId, setHostId] = useState("host-orbital");
  const [title, setTitle] = useState("Orbital live market room");
  const [created, setCreated] = useState<DotCastLivestreamCreateResponse | null>(null);
  const [loaded, setLoaded] = useState<DotCastLivestreamReadResponse | null>(null);
  const [studioError, setStudioError] = useState<string | null>(null);
  const [isWorking, setIsWorking] = useState(false);
  const [showStreamKey, setShowStreamKey] = useState(false);
  const [poolDraft, setPoolDraft] = useState({
    poolId: "orbital-side-pot-1",
    marketId: "dotcast:orbital:next-call",
    question: "Orbital nails the next on-air call?",
    unit: "points" as "cash" | "points"
  });

  const activeStreamId = created?.livestream?.streamId ?? streamId;

  const createStream = async () => {
    setIsWorking(true);
    setStudioError(null);

    try {
      const response = await createDotCastLivestream(apiBase, {
        streamId: streamId.trim() || undefined,
        hostId: hostId.trim(),
        title: title.trim(),
        metadata: { surface: "yevow-dotcast-studio" }
      });

      if (!response.ok) {
        throw new Error(response.error ?? "Livestream creation failed.");
      }

      setCreated(response);
      onRefresh();
    } catch (error) {
      setStudioError(error instanceof Error ? error.message : "Livestream creation failed.");
    } finally {
      setIsWorking(false);
    }
  };

  const loadStream = async () => {
    setIsWorking(true);
    setStudioError(null);

    try {
      const response = await readDotCastLivestream(apiBase, activeStreamId);

      if (!response.ok) {
        throw new Error(response.error ?? "Livestream lookup failed.");
      }

      setLoaded(response);
    } catch (error) {
      setStudioError(error instanceof Error ? error.message : "Livestream lookup failed.");
    } finally {
      setIsWorking(false);
    }
  };

  const runStreamAction = async (action: "start" | "pause" | "resume" | "end" | "archive") => {
    setIsWorking(true);
    setStudioError(null);

    try {
      const response = await updateDotCastLivestreamState(apiBase, activeStreamId, action);
      if (!response.ok) {
        throw new Error(String(response.error ?? `${action} failed.`));
      }
      await loadStream();
    } catch (error) {
      setStudioError(error instanceof Error ? error.message : `${action} failed.`);
    } finally {
      setIsWorking(false);
    }
  };

  const attachPool = async () => {
    setIsWorking(true);
    setStudioError(null);

    try {
      const response = await attachDotCastLivestreamPool(apiBase, activeStreamId, {
        ...poolDraft,
        status: "open",
        pinned: true
      });
      if (!response.ok) {
        throw new Error(String(response.error ?? "Pool attachment failed."));
      }
      await loadStream();
    } catch (error) {
      setStudioError(error instanceof Error ? error.message : "Pool attachment failed.");
    } finally {
      setIsWorking(false);
    }
  };

  return (
    <section className="dotcast-studio-grid">
      <div className="dotcast-command-panel glass">
        <div className="dotcast-panel-title">
          <Video size={17} />
          Host Studio
          <code>E Livestream</code>
        </div>
        <div className="dotcast-form-grid">
          <label>
            Stream ID
            <input value={streamId} onChange={(event) => setStreamId(event.target.value)} />
          </label>
          <label>
            Host ID
            <input value={hostId} onChange={(event) => setHostId(event.target.value)} />
          </label>
          <label className="span-2">
            Title
            <input value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
        </div>
        <div className="dotcast-button-row">
          <button
            className="primary-action"
            disabled={isWorking}
            onClick={() => void createStream()}
          >
            <Play size={15} />
            Create
          </button>
          <button disabled={isWorking} onClick={() => void loadStream()}>
            <RefreshCcw size={15} />
            Load
          </button>
          <button disabled={isWorking} onClick={() => void runStreamAction("start")}>
            <Play size={15} />
            Start
          </button>
          <button disabled={isWorking} onClick={() => void runStreamAction("pause")}>
            <Pause size={15} />
            Pause
          </button>
          <button disabled={isWorking} onClick={() => void runStreamAction("resume")}>
            <Zap size={15} />
            Resume
          </button>
          <button disabled={isWorking} onClick={() => void runStreamAction("end")}>
            <Square size={15} />
            End
          </button>
          <button disabled={isWorking} onClick={() => void runStreamAction("archive")}>
            <Archive size={15} />
            Archive
          </button>
        </div>
        {studioError ? <div className="dotcast-alert compact">{studioError}</div> : null}
      </div>

      <div className="dotcast-command-panel glass">
        <div className="dotcast-panel-title">
          <KeyRound size={17} />
          Ingest
          <code>
            {created?.livestream?.status ?? loaded?.livestream?.metadata?.status ?? "idle"}
          </code>
        </div>
        <CredentialRow label="RTMP" value={created?.hostIngest?.rtmpUrl ?? "pending"} />
        <div className="dotcast-secret-row">
          <span>Stream Key</span>
          <code>{showStreamKey ? (created?.hostIngest?.streamKey ?? "pending") : "masked"}</code>
          <button
            className="compact-action"
            onClick={() => setShowStreamKey((current) => !current)}
          >
            {showStreamKey ? <EyeOff size={14} /> : <Eye size={14} />}
            {showStreamKey ? "Hide" : "Reveal"}
          </button>
        </div>
        <CredentialRow
          label="Playback"
          value={created?.viewerPlayback?.playbackUrl ?? "waiting for stream"}
        />
      </div>

      <div className="dotcast-command-panel glass">
        <div className="dotcast-panel-title">
          <LinkIcon size={17} />
          Attach Pool
        </div>
        <div className="dotcast-form-grid">
          <label>
            Pool ID
            <input
              value={poolDraft.poolId}
              onChange={(event) => setPoolDraft({ ...poolDraft, poolId: event.target.value })}
            />
          </label>
          <label>
            Market ID
            <input
              value={poolDraft.marketId}
              onChange={(event) => setPoolDraft({ ...poolDraft, marketId: event.target.value })}
            />
          </label>
          <label className="span-2">
            Question
            <input
              value={poolDraft.question}
              onChange={(event) => setPoolDraft({ ...poolDraft, question: event.target.value })}
            />
          </label>
          <label>
            Unit
            <select
              value={poolDraft.unit}
              onChange={(event) =>
                setPoolDraft({ ...poolDraft, unit: event.target.value as "cash" | "points" })
              }
            >
              <option value="points">points</option>
              <option value="cash">cash</option>
            </select>
          </label>
        </div>
        <button
          className="primary-action full-action"
          disabled={isWorking}
          onClick={() => void attachPool()}
        >
          <LinkIcon size={15} />
          Attach
        </button>
      </div>

      <div className="dotcast-command-panel glass">
        <div className="dotcast-panel-title">
          <BellRing size={17} />
          Studio Queue
          <code>{queue.length}</code>
        </div>
        <div className="dotcast-stream-pools">
          {(loaded?.livestream?.pools ?? []).slice(0, 4).map((pool) => (
            <MiniPoolRow
              key={String(pool.poolId)}
              label={String(pool.question ?? pool.poolId)}
              value={String(pool.status ?? "attached")}
            />
          ))}
          {loaded?.livestream?.pools?.length ? null : (
            <>
              {samplePots.slice(0, 3).map((pool) => (
                <MiniPoolRow key={pool.poolId} label={pool.question} value={`${pool.yes}% yes`} />
              ))}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function ViewerLiveRoom({
  apiBase,
  status,
  onRefresh
}: {
  apiBase: string;
  status: StatusBundle;
  onRefresh: () => void;
}) {
  const [streamLookup, setStreamLookup] = useState("");
  const [playback, setPlayback] = useState<DotCastLivestreamCreateResponse | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [selectedAmount, setSelectedAmount] = useState(25);

  const lookupPlayback = async () => {
    if (!streamLookup.trim()) {
      return;
    }

    setLiveError(null);
    try {
      const response = await readDotCastLivestreamPlayback(apiBase, streamLookup.trim());
      if (!response.ok) {
        throw new Error(response.error ?? "Playback unavailable.");
      }
      setPlayback(response);
      onRefresh();
    } catch (error) {
      setLiveError(error instanceof Error ? error.message : "Playback unavailable.");
    }
  };

  return (
    <section className="dotcast-live-grid">
      <div className="dotcast-live-stage glass">
        <div className="dotcast-live-video">
          {playback?.viewerPlayback?.playbackUrl ? (
            <video controls muted playsInline src={playback.viewerPlayback.playbackUrl} />
          ) : (
            <div className="dotcast-video-placeholder">
              <MonitorPlay size={44} />
              <strong>dotCast Live</strong>
              <span>Mux playback appears here when a stream is loaded.</span>
            </div>
          )}
        </div>
        <div className="dotcast-live-meta">
          <div>
            <strong>
              {playback?.livestream?.title ?? "Static fire recap - orbital window this quarter?"}
            </strong>
            <span>
              {playback?.livestream?.hostId ?? "Orbital"} ·{" "}
              {playback?.livestream?.status ?? "preview"}
            </span>
          </div>
          <button>
            <Users size={15} />+ Follow
          </button>
        </div>
      </div>

      <div className="dotcast-command-panel glass">
        <div className="dotcast-panel-title">
          <MonitorPlay size={17} />
          Viewer Room
        </div>
        <label>
          Stream ID
          <input value={streamLookup} onChange={(event) => setStreamLookup(event.target.value)} />
        </label>
        <button className="primary-action full-action" onClick={() => void lookupPlayback()}>
          <RefreshCcw size={15} />
          Load Playback
        </button>
        {liveError ? <div className="dotcast-alert compact">{liveError}</div> : null}
        <div className="dotcast-viewer-stat-grid">
          <MetricCard
            label="Rewarded"
            value={status.health?.rewardedStream?.ready ? "Ready" : "Guarded"}
            detail={`${String(status.health?.rewardedStream?.requiredCompletions ?? 3)} streams`}
          />
          <MetricCard
            label="Free Entry"
            value={`x${String(status.health?.rewardedStream?.freeEntryReward ?? 1)}`}
            detail="reward ledger"
          />
        </div>
      </div>

      <div className="dotcast-prediction-card glass">
        <div className="dotcast-live-badges">
          <span>LIVE</span>
          <code>12.3K</code>
        </div>
        <div className="dotcast-stream-avatar">OR</div>
        <div className="dotcast-market-copy">
          <code>resolves 04:18</code>
          <h2>Orbital nails the next on-air call?</h2>
        </div>
        <div className="dotcast-odds-row">
          <button className="yes">
            <Flame size={26} />
            Yes 33%
            <small>win {currency.format(selectedAmount * 2.9)}</small>
          </button>
          <button className="no">
            <Zap size={26} />
            No 67%
            <small>win {currency.format(selectedAmount * 1.45)}</small>
          </button>
        </div>
        <div className="dotcast-amount-row">
          {[10, 25, 100].map((amount) => (
            <button
              className={selectedAmount === amount ? "active" : ""}
              key={amount}
              onClick={() => setSelectedAmount(amount)}
            >
              ${amount}
            </button>
          ))}
          <button onClick={() => setSelectedAmount(250)}>Max</button>
        </div>
      </div>

      <div className="dotcast-command-panel glass dotcast-live-pots">
        <div className="dotcast-panel-title">
          <CircleDot size={17} />
          Live Pots
          <code>{samplePots.length} running</code>
        </div>
        {samplePots.map((pool) => (
          <div className="dotcast-pot-row" key={pool.poolId}>
            <div>
              <strong>{pool.question}</strong>
              <span>{pool.poolId}</span>
            </div>
            <code>{pool.yes}%</code>
          </div>
        ))}
      </div>
    </section>
  );
}

function ResolutionDashboard({
  apiBase,
  queue,
  reviews,
  status,
  onRefresh
}: {
  apiBase: string;
  queue: DotCastResolutionRoute[];
  reviews: DotCastResolutionReview[];
  status: StatusBundle;
  onRefresh: () => void;
}) {
  const [resolverId, setResolverId] = useState("resolver-admin");
  const [action, setAction] = useState<
    "activate" | "suspend" | "archive" | "adjust_bond" | "adjust_reputation"
  >("suspend");
  const [delta, setDelta] = useState(0);
  const [reason, setReason] = useState("manual review");
  const [adminStatus, setAdminStatus] = useState<string | null>(null);

  const applyAdminAction = async () => {
    setAdminStatus(null);

    try {
      const response = await applyDotCastResolverAdminAction(apiBase, resolverId.trim(), {
        action,
        adminId: "yevow-dotcast-ui",
        reason,
        ...(action === "adjust_bond" ? { bondDeltaMinorUnits: delta } : {}),
        ...(action === "adjust_reputation" ? { reputationDeltaBps: delta } : {})
      });

      if (!response.ok) {
        throw new Error(String(response.error ?? "Resolver action failed."));
      }

      setAdminStatus("applied");
      onRefresh();
    } catch (error) {
      setAdminStatus(error instanceof Error ? error.message : "Resolver action failed.");
    }
  };

  return (
    <section className="dotcast-resolution-grid">
      <div className="dotcast-command-panel glass">
        <div className="dotcast-panel-title">
          <ClipboardList size={17} />
          Resolution Trust
          <code>E13</code>
        </div>
        <div className="dotcast-trust-grid">
          <MetricCard
            label="Classifier"
            value={String(status.health?.resolutionRouter?.classifierVersion ?? "v1")}
            detail={`${compact.format(Number(status.health?.resolutionRouter?.minConfidenceBps ?? 8000) / 100)}% min`}
          />
          <MetricCard
            label="AI Auto"
            value={`${compact.format(Number(status.health?.resolutionRouter?.aiAutoConfidenceBps ?? 9500) / 100)}%`}
            detail="confidence gate"
          />
          <MetricCard
            label="Panel"
            value={`${String(status.health?.resolutionRouter?.basePanelSize ?? 3)} / ${String(
              status.health?.resolutionRouter?.highStakesPanelSize ?? 7
            )}`}
            detail="base / high stakes"
          />
          <MetricCard
            label="Min Bond"
            value={currency.format(
              Number(status.health?.resolutionRouter?.resolverMinBondMinorUnits ?? 50000) / 100
            )}
            detail="resolver registry"
          />
        </div>
      </div>

      <div className="dotcast-command-panel glass">
        <div className="dotcast-panel-title">
          <ShieldCheck size={17} />
          Resolver Admin
        </div>
        <div className="dotcast-form-grid">
          <label>
            Resolver ID
            <input value={resolverId} onChange={(event) => setResolverId(event.target.value)} />
          </label>
          <label>
            Action
            <select
              value={action}
              onChange={(event) =>
                setAction(
                  event.target.value as
                    | "activate"
                    | "suspend"
                    | "archive"
                    | "adjust_bond"
                    | "adjust_reputation"
                )
              }
            >
              <option value="suspend">suspend</option>
              <option value="activate">activate</option>
              <option value="archive">archive</option>
              <option value="adjust_bond">adjust bond</option>
              <option value="adjust_reputation">adjust reputation</option>
            </select>
          </label>
          <label>
            Delta
            <input
              type="number"
              value={delta}
              onChange={(event) => setDelta(Number(event.target.value))}
            />
          </label>
          <label>
            Reason
            <input value={reason} onChange={(event) => setReason(event.target.value)} />
          </label>
        </div>
        <button className="primary-action full-action" onClick={() => void applyAdminAction()}>
          <BadgeCheck size={15} />
          Apply
        </button>
        {adminStatus ? <div className="dotcast-alert compact">{adminStatus}</div> : null}
      </div>

      <QueuePanel queue={queue} />
      <ReviewsPanel reviews={reviews} />
    </section>
  );
}

function QueuePanel({ queue }: { queue: DotCastResolutionRoute[] }) {
  return (
    <div className="dotcast-command-panel glass">
      <div className="dotcast-panel-title">
        <ClipboardList size={17} />
        Review Queue
        <code>{queue.length}</code>
      </div>
      <div className="dotcast-queue-list">
        {queue.length ? (
          queue.map((route) => (
            <div className="dotcast-queue-row" key={route.routeId}>
              <div>
                <strong>{route.marketId}</strong>
                <span>{route.resolutionStatement}</span>
              </div>
              <code>{route.tier}</code>
              <small>{compact.format(route.confidenceBps / 100)}%</small>
            </div>
          ))
        ) : (
          <EmptyState
            label="No review-required routes loaded."
            icon={<ClipboardList size={22} />}
          />
        )}
      </div>
    </div>
  );
}

function ReviewsPanel({ reviews }: { reviews: DotCastResolutionReview[] }) {
  return (
    <div className="dotcast-command-panel glass">
      <div className="dotcast-panel-title">
        <ListChecks size={17} />
        Review Decisions
        <code>{reviews.length}</code>
      </div>
      <div className="dotcast-review-list">
        {reviews.length ? (
          reviews.map((review) => (
            <div className="dotcast-review-row" key={review.reviewId}>
              <div>
                <strong>{review.status}</strong>
                <span>{review.marketId}</span>
              </div>
              <code>{review.reviewerId}</code>
            </div>
          ))
        ) : (
          <EmptyState label="No decisions loaded." icon={<ListChecks size={22} />} />
        )}
      </div>
    </div>
  );
}

function MetricCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="dotcast-metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function ReadinessCard({
  label,
  value,
  detail,
  icon
}: {
  label: string;
  value: string;
  detail: string;
  icon: JSX.Element;
}) {
  return (
    <div className="dotcast-readiness-card">
      <div>{icon}</div>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function SafetyPill({
  label,
  value,
  tone,
  icon
}: {
  label: string;
  value: string;
  tone: "green" | "amber" | "red" | "blue";
  icon: JSX.Element;
}) {
  return (
    <div className={`dotcast-safety-pill ${tone}`}>
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function GuardRow({
  label,
  value,
  tone
}: {
  label: string;
  value: string;
  tone: "green" | "amber" | "red" | "blue";
}) {
  return (
    <div className={`dotcast-guard-row ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function CredentialRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="dotcast-credential-row">
      <span>{label}</span>
      <code>{value}</code>
    </div>
  );
}

function MiniPoolRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="dotcast-mini-pool-row">
      <span>{label}</span>
      <code>{value}</code>
    </div>
  );
}

function EmptyState({ label, icon }: { label: string; icon: JSX.Element }) {
  return (
    <div className="dotcast-empty">
      {icon}
      <span>{label}</span>
    </div>
  );
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}
