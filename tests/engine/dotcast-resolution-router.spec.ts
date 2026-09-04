import { describe, expect, it } from "vitest";
import {
  classifyDotCastResolutionRoute,
  createDotCastResolverCommit,
  decideDotCastResolutionChallenge,
  evaluateDotCastResolutionChallengeSettlementPolicy,
  openDotCastResolutionChallenge,
  prepareDotCastPoolResolutionRoute,
  resolveDotCastAiPerception,
  revealDotCastResolverCommit,
  selectDotCastResolverPanel,
  settleDotCastResolverPanel,
  type DotCastMarketSnapshot,
  type DotCastResolutionRoute,
  type DotCastResolverProfile
} from "../../src/engine/dotcast";

const now = "2099-06-25T17:00:00.000Z";

describe("dotCast E13 resolution router", () => {
  it("locks objective external routes and refuses real-money subjective markets", () => {
    const route = classifyDotCastResolutionRoute(env(), {
      market: market({
        venue: "kalshi",
        question: "Will the official Fed target rate be above 4% on June 30?",
        referenceUrl: "https://kalshi.example/markets/fed-rate"
      }),
      unit: "usdc",
      poolId: "pool-hard",
      now
    });

    expect(route).toMatchObject({
      tier: "hard_oracle",
      status: "locked",
      sourceAvailable: true,
      autoResolvable: true,
      feeBps: 0,
      lockedAt: now
    });

    expect(() =>
      prepareDotCastPoolResolutionRoute(env(), {
        market: market({
          id: "dotcast:subjective",
          venue: "dotcast",
          question: "Was this the best segment of the stream?",
          referenceUrl: undefined
        }),
        unit: "usdc",
        poolId: "pool-subjective",
        now
      })
    ).toThrow(/locked E13 resolution route/);

    const pointsRoute = prepareDotCastPoolResolutionRoute(env(), {
      market: market({
        id: "dotcast:subjective-points",
        venue: "dotcast",
        question: "Was this the best segment of the stream?",
        referenceUrl: undefined
      }),
      unit: "points",
      poolId: "pool-points",
      now
    });

    expect(pointsRoute).toMatchObject({
      tier: "human_jury",
      status: "points_only",
      pointsOnly: true
    });
    expect(pointsRoute.steeringPrompt).toContain("externally verifiable");
  });

  it("logs AI confidence and escalates below the auto-resolution threshold", () => {
    const route = classifyDotCastResolutionRoute(env(), {
      market: market({
        id: "dotcast:stream-ai",
        venue: "dotcast",
        question: "Does the host say the launch code on stream?"
      }),
      unit: "points",
      poolId: "pool-ai",
      streamId: "stream-ai",
      now
    });

    expect(route).toMatchObject({
      tier: "ai_perception",
      status: "locked",
      autoResolvable: false
    });

    const escalated = resolveDotCastAiPerception(env(), {
      route,
      modelConfidenceBps: 9400,
      predictedOutcome: "yes",
      evidenceRefs: ["mux-asset:clip-1"],
      now: "2099-06-25T17:05:00.000Z"
    });

    expect(escalated).toMatchObject({
      status: "escalated",
      outcome: "pending",
      escalatedRoute: {
        tier: "optimistic_bonded",
        feeBps: 200,
        reviewRequired: true
      },
      log: {
        modelConfidenceBps: 9400,
        thresholdBps: 9500,
        action: "escalated"
      }
    });

    const auto = resolveDotCastAiPerception(env(), {
      route,
      modelConfidenceBps: 9700,
      predictedOutcome: "yes",
      evidenceRefs: ["mux-asset:clip-2"],
      now: "2099-06-25T17:06:00.000Z"
    });

    expect(auto).toMatchObject({
      status: "auto_resolved",
      outcome: "yes",
      escalatedRoute: null
    });
  });

  it("builds stake-scaled resolver panels with stake exclusion, Sybil resistance, and pay-for-correctness", async () => {
    const route: DotCastResolutionRoute = {
      ...classifyDotCastResolutionRoute(env(), {
        market: market({
          id: "dotcast:ambiguous",
          venue: "dotcast",
          question: "Will the backstage decision be confirmed before the stream ends?"
        }),
        unit: "points",
        poolId: "pool-resolver",
        now
      }),
      tier: "optimistic_bonded",
      status: "locked",
      feeBps: 200,
      bondMinorUnits: 250_000,
      panelSize: 5,
      lockedAt: now
    };
    const candidates = resolverCandidates();
    const panel = selectDotCastResolverPanel(
      {
        ...env(),
        DOTCAST_RESOLUTION_HIGH_STAKES_THRESHOLD_MINOR_UNITS: "1000",
        DOTCAST_RESOLVER_HIGH_STAKES_PANEL_SIZE: "5"
      },
      {
        poolId: "pool-resolver",
        route,
        candidates,
        positionUserIds: ["resolver-with-stake"],
        estimatedStakeMinorUnits: 5_000_000,
        panelId: "panel-1",
        now
      }
    );

    expect(panel.assignments).toHaveLength(5);
    expect(panel.panelSize).toBe(5);
    expect(panel.resolverFeeBps).toBe(200);
    expect(panel.assignments.map((assignment) => assignment.resolverId)).not.toContain(
      "resolver-with-stake"
    );
    expect(new Set(panel.assignments.map((assignment) => assignment.identityHash)).size).toBe(
      panel.assignments.length
    );

    const hardOraclePanel = selectDotCastResolverPanel(env(), {
      poolId: "pool-hard-panel",
      route: { ...route, tier: "hard_oracle" },
      candidates,
      estimatedStakeMinorUnits: 100,
      panelId: "panel-hard",
      now
    });
    expect(hardOraclePanel.resolverFeeBps).toBe(0);

    const commits = await Promise.all(
      panel.assignments.map((assignment, index) =>
        createDotCastResolverCommit({
          assignment,
          outcome: index < 3 ? "yes" : "no",
          salt: `salt-${index}`,
          now: `2099-06-25T17:0${index}:00.000Z`
        })
      )
    );
    const reveals = await Promise.all(
      commits.map((commit, index) =>
        revealDotCastResolverCommit({
          commit,
          outcome: index < 3 ? "yes" : "no",
          salt: `salt-${index}`,
          now: `2099-06-25T17:1${index}:00.000Z`
        })
      )
    );
    const settlement = settleDotCastResolverPanel({
      panel,
      reveals,
      now: "2099-06-25T17:20:00.000Z"
    });

    expect(settlement.consensusOutcome).toBe("yes");
    expect(settlement.payouts.filter((payout) => payout.matchedConsensus)).toHaveLength(3);
    expect(settlement.payouts.find((payout) => !payout.matchedConsensus)).toMatchObject({
      bondReturnedMinorUnits: 0,
      feePaidMinorUnits: 0,
      slashedBondMinorUnits: 250_000
    });
    expect(
      settlement.payouts.find((payout) => payout.matchedConsensus)?.feePaidMinorUnits
    ).toBeGreaterThan(0);

    await expect(
      revealDotCastResolverCommit({
        commit: commits[0],
        outcome: "no",
        salt: "wrong-salt"
      })
    ).rejects.toThrow(/does not match/);
  });

  it("gates optimistic settlement by challenge status while allowing resolver escalation", () => {
    const route: DotCastResolutionRoute = {
      ...classifyDotCastResolutionRoute(env(), {
        market: market({
          id: "dotcast:e13-challenge-policy",
          venue: "dotcast",
          question: "Will the ambiguous stream event happen?"
        }),
        unit: "points",
        poolId: "pool-challenge-policy",
        now
      }),
      tier: "optimistic_bonded",
      status: "locked",
      feeBps: 200,
      bondMinorUnits: 50_000,
      panelSize: 3,
      lockedAt: now
    };
    const opened = openDotCastResolutionChallenge({
      route,
      challengerId: "challenger-policy",
      reason: "counter-evidence",
      now: "2099-06-25T17:05:00.000Z"
    });
    const accepted = decideDotCastResolutionChallenge({
      challenge: opened,
      action: "accept",
      decisionBy: "operator-policy",
      now: "2099-06-25T17:10:00.000Z"
    });
    const rejected = decideDotCastResolutionChallenge({
      challenge: { ...opened, challengeId: "challenge-rejected" },
      action: "reject",
      decisionBy: "operator-policy",
      now: "2099-06-25T17:11:00.000Z"
    });

    expect(evaluateDotCastResolutionChallengeSettlementPolicy(route, [opened])).toMatchObject({
      action: "hold",
      reason: "open_challenge_holds_optimistic_settlement"
    });
    expect(evaluateDotCastResolutionChallengeSettlementPolicy(route, [accepted])).toMatchObject({
      action: "block",
      reason: "accepted_challenge_blocks_optimistic_settlement"
    });
    expect(
      evaluateDotCastResolutionChallengeSettlementPolicy(route, [accepted], {
        settlementSource: "resolver_consensus"
      })
    ).toMatchObject({
      action: "allow",
      reason: "accepted_challenge_resolved_by_escalation"
    });
    expect(evaluateDotCastResolutionChallengeSettlementPolicy(route, [rejected])).toMatchObject({
      action: "allow",
      reason: "all_challenges_rejected_or_expired"
    });
  });
});

function env() {
  return {
    DOTCAST_RESOLUTION_ROUTER_ENABLED: "true",
    DOTCAST_RESOLUTION_CLASSIFIER_MIN_CONFIDENCE_BPS: "8000",
    DOTCAST_AI_PERCEPTION_AUTO_CONFIDENCE_BPS: "9500",
    DOTCAST_RESOLVER_FEE_BPS: "200"
  };
}

function market(overrides: Partial<DotCastMarketSnapshot> = {}): DotCastMarketSnapshot {
  return {
    id: "kalshi:fed-rate",
    venue: "kalshi",
    question: "Will this objective fact settle?",
    status: "open",
    closeTime: "2099-06-25T18:00:00.000Z",
    expectedResolveAt: "2099-06-25T19:00:00.000Z",
    referenceUrl: "https://example.com/source",
    ...overrides
  };
}

function resolverCandidates(): DotCastResolverProfile[] {
  return [
    resolver("resolver-with-stake", "id-stake", 9800, ["pool-resolver"]),
    resolver("resolver-dupe-low", "id-dupe", 7000),
    resolver("resolver-dupe-high", "id-dupe", 9000),
    resolver("resolver-a", "id-a", 8700),
    resolver("resolver-b", "id-b", 8600),
    resolver("resolver-c", "id-c", 8500),
    resolver("resolver-d", "id-d", 8400),
    resolver("resolver-e", "id-e", 8300),
    resolver("resolver-f", "id-f", 8200)
  ];
}

function resolver(
  resolverId: string,
  identityHash: string,
  reputationBps: number,
  stakeHeldPoolIds: string[] = []
): DotCastResolverProfile {
  return {
    resolverId,
    identityHash,
    reputationBps,
    bondAvailableMinorUnits: 1_000_000,
    stakeHeldPoolIds
  };
}
