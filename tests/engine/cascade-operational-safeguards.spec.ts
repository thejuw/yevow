import { describe, expect, it } from "vitest";
import {
  cascadeAlertPolicy,
  evaluateCascadeLiveReadiness,
  type CascadeAlertEventType,
  type CascadeLiveReadinessInput,
  type CascadeReadinessCheck
} from "../../src/strategy/cascade/OperationalSafeguards";

const NOW_MS = Date.parse("2026-05-18T12:00:00.000Z");

describe("cascade operational live-readiness gates", () => {
  it("blocks premature cascade live promotion with explicit failed checks", () => {
    const report = evaluateCascadeLiveReadiness({
      ...readyInput(),
      paperArmedAt: "2026-05-17T12:00:00.000Z",
      paperTradeCount: 12,
      paperPnlR: 2,
      backtestPositiveExpectancy: false,
      backtestTradeCount: 0,
      backtestTotalPnl: -1,
      lastCascadeConfigChangeAt: "2026-05-18T10:00:00.000Z",
      readApproval: null
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report.checks)).toEqual([
      "cascade_backtest_expectancy",
      "cascade_paper_duration",
      "cascade_paper_trades",
      "cascade_paper_pnl_r",
      "cascade_config_freeze",
      "cascade_two_person_rule"
    ]);
  });

  it("allows promotion only after paper evidence, config freeze, and fresh two-person approval", () => {
    const report = evaluateCascadeLiveReadiness(readyInput());

    expect(report.ok).toBe(true);
    expect(report.checks.every((check) => check.ok)).toBe(true);
  });

  it("does not allow the same token or subject to satisfy the two-person rule", () => {
    const report = evaluateCascadeLiveReadiness({
      ...readyInput(),
      readApproval: {
        jti: "same-token",
        subject: "operator-a",
        scopes: ["READ"],
        observedAt: "2026-05-18T11:58:00.000Z"
      },
      writeToken: {
        jti: "same-token",
        subject: "operator-a",
        scopes: ["WRITE"],
        observedAt: "2026-05-18T12:00:00.000Z"
      }
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report.checks)).toContain("cascade_two_person_rule");
  });

  it("rejects stale read approval even when the operators are distinct", () => {
    const report = evaluateCascadeLiveReadiness({
      ...readyInput(),
      readApproval: {
        jti: "reader-token",
        subject: "operator-a",
        scopes: ["READ"],
        observedAt: "2026-05-18T11:50:00.000Z"
      }
    });

    expect(report.ok).toBe(false);
    expect(
      report.checks.find((check) => check.id === "cascade_two_person_rule")?.metadata
    ).toMatchObject({ readApprovalFresh: false, distinctApproval: true });
  });
});

describe("cascade operational alert routing", () => {
  it("routes each cascade alert priority to the required channels", () => {
    const expected: Record<CascadeAlertEventType, ReturnType<typeof cascadeAlertPolicy>> = {
      CASCADE_DETECTED: {
        eventType: "CASCADE_DETECTED",
        priority: "LOW",
        routes: ["DASHBOARD"],
        externalDelivery: false
      },
      CASCADE_ABSORPTION_CONFIRMED: {
        eventType: "CASCADE_ABSORPTION_CONFIRMED",
        priority: "MEDIUM",
        routes: ["DASHBOARD", "LOG"],
        externalDelivery: false
      },
      SIGNAL_EMITTED: {
        eventType: "SIGNAL_EMITTED",
        priority: "MEDIUM",
        routes: ["DASHBOARD", "LOG"],
        externalDelivery: false
      },
      POSITION_OPENED: {
        eventType: "POSITION_OPENED",
        priority: "HIGH",
        routes: ["DASHBOARD", "LOG", "ALL_CHANNELS"],
        externalDelivery: true
      },
      STOP_HIT: {
        eventType: "STOP_HIT",
        priority: "HIGH",
        routes: ["DASHBOARD", "LOG", "ALL_CHANNELS"],
        externalDelivery: true
      },
      TIME_STOP_HIT: {
        eventType: "TIME_STOP_HIT",
        priority: "HIGH",
        routes: ["DASHBOARD", "LOG", "ALL_CHANNELS"],
        externalDelivery: true
      },
      LOSS_LIMIT_BREACHED: {
        eventType: "LOSS_LIMIT_BREACHED",
        priority: "CRITICAL",
        routes: ["DASHBOARD", "LOG", "ALL_CHANNELS", "MANUAL_UNBLOCK"],
        externalDelivery: true
      },
      DRAWDOWN_LIMIT_BREACHED: {
        eventType: "DRAWDOWN_LIMIT_BREACHED",
        priority: "CRITICAL",
        routes: ["DASHBOARD", "LOG", "ALL_CHANNELS", "MANUAL_UNBLOCK"],
        externalDelivery: true
      },
      HEAT_CAP_EXCEEDED: {
        eventType: "HEAT_CAP_EXCEEDED",
        priority: "CRITICAL",
        routes: ["DASHBOARD", "LOG", "ALL_CHANNELS", "MANUAL_UNBLOCK"],
        externalDelivery: true
      }
    };

    for (const [eventType, policy] of Object.entries(expected) as [
      CascadeAlertEventType,
      ReturnType<typeof cascadeAlertPolicy>
    ][]) {
      expect(cascadeAlertPolicy(eventType)).toEqual(policy);
    }
  });
});

function readyInput(): CascadeLiveReadinessInput {
  return {
    nowMs: NOW_MS,
    paperArmedAt: "2026-04-01T12:00:00.000Z",
    minPaperDays: 30,
    paperTradeCount: 42,
    minPaperTrades: 30,
    paperPnlR: 12.5,
    minPaperPnlR: 10,
    backtestPositiveExpectancy: true,
    backtestTradeCount: 18,
    backtestTotalPnl: 430.25,
    backtestReportId: "backtest-ready",
    lastCascadeConfigChangeAt: "2026-05-14T11:00:00.000Z",
    configFreezeHours: 72,
    readApproval: {
      jti: "reader-token",
      subject: "operator-a",
      scopes: ["READ"],
      observedAt: "2026-05-18T11:58:00.000Z"
    },
    writeToken: {
      jti: "writer-token",
      subject: "operator-b",
      scopes: ["WRITE"],
      observedAt: "2026-05-18T12:00:00.000Z"
    },
    approvalWindowMs: 5 * 60_000
  };
}

function failedIds(checks: CascadeReadinessCheck[]): string[] {
  return checks.filter((check) => !check.ok).map((check) => check.id);
}
