import type { AlertPriority } from "../../utils/Notifier";
import type { JsonRecord } from "../../types";

export type CascadeAlertEventType =
  | "CASCADE_DETECTED"
  | "CASCADE_ABSORPTION_CONFIRMED"
  | "SIGNAL_EMITTED"
  | "POSITION_OPENED"
  | "STOP_HIT"
  | "TIME_STOP_HIT"
  | "LOSS_LIMIT_BREACHED"
  | "DRAWDOWN_LIMIT_BREACHED"
  | "HEAT_CAP_EXCEEDED";

export type CascadeAlertRoute = "DASHBOARD" | "LOG" | "ALL_CHANNELS" | "MANUAL_UNBLOCK";

export interface CascadeAlertPolicy {
  eventType: CascadeAlertEventType;
  priority: AlertPriority;
  routes: CascadeAlertRoute[];
  externalDelivery: boolean;
}

export interface CascadeLiveReadinessInput {
  nowMs: number;
  paperArmedAt: string | null;
  minPaperDays: number;
  paperTradeCount: number;
  minPaperTrades: number;
  paperPnlR: number;
  minPaperPnlR: number;
  backtestPositiveExpectancy: boolean;
  backtestTradeCount: number;
  backtestTotalPnl: number;
  backtestReportId: string | null;
  lastCascadeConfigChangeAt: string | null;
  configFreezeHours: number;
  readApproval: TwoPersonApproval | null;
  writeToken: TwoPersonApproval;
  approvalWindowMs: number;
}

export interface TwoPersonApproval {
  jti: string;
  subject: string;
  scopes: string[];
  observedAt: string;
}

export interface CascadeReadinessCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  metadata: JsonRecord;
}

export interface CascadeLiveReadinessReport {
  ok: boolean;
  checks: CascadeReadinessCheck[];
}

const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;

export function cascadeAlertPolicy(eventType: CascadeAlertEventType): CascadeAlertPolicy {
  switch (eventType) {
    case "CASCADE_DETECTED":
      return {
        eventType,
        priority: "LOW",
        routes: ["DASHBOARD"],
        externalDelivery: false
      };
    case "CASCADE_ABSORPTION_CONFIRMED":
    case "SIGNAL_EMITTED":
      return {
        eventType,
        priority: "MEDIUM",
        routes: ["DASHBOARD", "LOG"],
        externalDelivery: false
      };
    case "POSITION_OPENED":
    case "STOP_HIT":
    case "TIME_STOP_HIT":
      return {
        eventType,
        priority: "HIGH",
        routes: ["DASHBOARD", "LOG", "ALL_CHANNELS"],
        externalDelivery: true
      };
    case "LOSS_LIMIT_BREACHED":
    case "DRAWDOWN_LIMIT_BREACHED":
    case "HEAT_CAP_EXCEEDED":
      return {
        eventType,
        priority: "CRITICAL",
        routes: ["DASHBOARD", "LOG", "ALL_CHANNELS", "MANUAL_UNBLOCK"],
        externalDelivery: true
      };
  }
}

export function evaluateCascadeLiveReadiness(
  input: CascadeLiveReadinessInput
): CascadeLiveReadinessReport {
  const paperMs = input.paperArmedAt ? input.nowMs - Date.parse(input.paperArmedAt) : null;
  const configQuietMs = input.lastCascadeConfigChangeAt
    ? input.nowMs - Date.parse(input.lastCascadeConfigChangeAt)
    : null;
  const approvalMs = input.readApproval
    ? input.nowMs - Date.parse(input.readApproval.observedAt)
    : null;
  const distinctApproval =
    input.readApproval !== null &&
    input.readApproval.jti !== input.writeToken.jti &&
    input.readApproval.subject !== input.writeToken.subject;
  const approvalFresh =
    approvalMs !== null &&
    Number.isFinite(approvalMs) &&
    approvalMs >= 0 &&
    approvalMs <= input.approvalWindowMs;
  const readApprovalHasRead =
    input.readApproval?.scopes.includes("READ") === true ||
    input.readApproval?.scopes.includes("TELEMETRY:READ") === true;
  const writeTokenHasWrite =
    input.writeToken.scopes.includes("WRITE") ||
    input.writeToken.scopes.includes("TRADING:WRITE") ||
    input.writeToken.scopes.includes("CONFIG:WRITE");

  const checks = [
    check(
      "cascade_backtest_expectancy",
      "Cascade Backtest Expectancy",
      input.backtestPositiveExpectancy && input.backtestTradeCount > 0,
      input.backtestPositiveExpectancy
        ? `Latest cascade backtest is positive with ${input.backtestTradeCount} trade(s).`
        : "A positive-expectancy cascade backtest is required before live promotion.",
      {
        reportId: input.backtestReportId,
        tradeCount: input.backtestTradeCount,
        totalPnl: round(input.backtestTotalPnl, 8)
      }
    ),
    check(
      "cascade_paper_duration",
      "Cascade Paper Duration",
      paperMs !== null && paperMs >= input.minPaperDays * MS_PER_DAY,
      paperMs === null
        ? "Cascade paper-mode arming timestamp is not recorded."
        : `Cascade paper mode has been armed for ${round(paperMs / MS_PER_DAY, 3)} day(s).`,
      {
        paperArmedAt: input.paperArmedAt,
        minPaperDays: input.minPaperDays
      }
    ),
    check(
      "cascade_paper_trades",
      "Cascade Paper Trades",
      input.paperTradeCount >= input.minPaperTrades,
      `${input.paperTradeCount} cascade paper trade(s) versus ${input.minPaperTrades} required.`,
      {
        paperTradeCount: input.paperTradeCount,
        minPaperTrades: input.minPaperTrades
      }
    ),
    check(
      "cascade_paper_pnl_r",
      "Cascade Paper PnL R",
      input.paperPnlR >= input.minPaperPnlR,
      `${round(input.paperPnlR, 4)}R paper PnL versus ${round(input.minPaperPnlR, 4)}R required.`,
      {
        paperPnlR: round(input.paperPnlR, 8),
        minPaperPnlR: input.minPaperPnlR
      }
    ),
    check(
      "cascade_config_freeze",
      "Cascade Config Freeze",
      configQuietMs !== null && configQuietMs >= input.configFreezeHours * MS_PER_HOUR,
      configQuietMs === null
        ? "No cascade config-change timestamp is recorded."
        : `Last cascade config change was ${round(configQuietMs / MS_PER_HOUR, 3)} hour(s) ago.`,
      {
        lastCascadeConfigChangeAt: input.lastCascadeConfigChangeAt,
        configFreezeHours: input.configFreezeHours
      }
    ),
    check(
      "cascade_two_person_rule",
      "Two-Person Approval",
      distinctApproval && approvalFresh && readApprovalHasRead && writeTokenHasWrite,
      input.readApproval === null
        ? "A fresh READ approval token is required before WRITE promotion."
        : distinctApproval
          ? "Distinct READ and WRITE approvals are present inside the 5-minute window."
          : "The same token or subject cannot approve and promote cascade live mode.",
      {
        approvalWindowMs: input.approvalWindowMs,
        readApprovalSubject: input.readApproval?.subject ?? null,
        writeSubject: input.writeToken.subject,
        readApprovalFresh: approvalFresh,
        distinctApproval,
        readApprovalHasRead,
        writeTokenHasWrite
      }
    )
  ];

  return {
    ok: checks.every((item) => item.ok),
    checks
  };
}

function check(
  id: string,
  label: string,
  ok: boolean,
  detail: string,
  metadata: JsonRecord
): CascadeReadinessCheck {
  return { id, label, ok, detail, metadata };
}

function round(value: number, places: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
