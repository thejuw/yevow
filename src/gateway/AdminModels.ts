import type { AdminScope, AuthClaims } from "../AuthManager";
import type { AlertPriority } from "../utils/Notifier";
import type { JsonRecord, NotificationSettingsUpdate } from "../types";

export interface LoginRequest {
  password?: string;
  subject?: string;
  scopes?: AdminScope[] | string;
}

export interface AuthenticatedAdmin {
  claims: AuthClaims;
  subject: string;
}

export interface LogRow {
  id: number;
  level: string;
  event_type: string;
  source: string;
  message: string;
  correlation_id: string | null;
  telemetry_json: string | null;
  created_at: string;
}

export interface TradeHistoryRow {
  trade_id: string;
  order_id: string;
  signal_id: string | null;
  venue: string;
  asset: string;
  side: string;
  order_type: string;
  price: number;
  size: number;
  notional: number;
  ev_at_execution: number;
  slippage_bps: number;
  resulting_pnl?: number | null;
  primary_driver?: string | null;
  fees: number;
  status: string;
  exchange_trade_id: string | null;
  raw_execution_json: string | null;
  executed_at: string;
  created_at: string;
  agent_name: string | null;
  trace_id: string | null;
}

export interface PaperPnlAggregateRow {
  asset: string;
  trade_count: number;
  buy_count: number;
  sell_count: number;
  buy_size: number | null;
  sell_size: number | null;
  buy_notional: number | null;
  sell_notional: number | null;
  total_ev: number | null;
  total_fees: number | null;
  realized_pnl: number | null;
  first_seen: string | null;
  last_seen: string | null;
}

export interface TradeStatusBreakdownRow {
  status: string;
  count: number;
  latest_executed_at: string | null;
}

export interface PaperLedgerFillRow extends TradeHistoryRow {
  status: "GHOST_FILL";
}

export interface ExecutionQualityAggregateRow {
  sample_count: number;
  average_slippage_bps: number | null;
  adverse_selection_bps: number | null;
  average_shortfall: number | null;
  average_latency_ms: number | null;
  total_fees: number | null;
}

export interface ExecutionQualityAssetRow extends ExecutionQualityAggregateRow {
  instrument_code: string;
}

export interface CountRow {
  count: number;
}

export interface CostBudgetSettings {
  schemaVersion: "cost-budgets.v1";
  dailyBudgetUsd: number;
  workersAiDailyBudgetUsd: number;
  durableObjectDailyBudgetUsd: number;
  d1DailyBudgetUsd: number;
  workersAiCostPerCallUsd: number;
  durableObjectCostPerMsUsd: number;
  d1ReadCostPerQueryUsd: number;
  d1WriteCostPerRowUsd: number;
  enforcement: "WARN" | "BLOCK_LIVE" | "BLOCK_ALL";
  updatedAt: string;
  updatedBy: string;
}

export interface LiveReadinessCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  metadata?: JsonRecord;
}

export interface LiveReadinessReport {
  ok: boolean;
  generatedAt: string;
  checks: LiveReadinessCheck[];
}

export interface AgentTraceRow {
  decision_id: string;
  signal_id: string;
  trace_id: string;
  agent_name: string;
  target_agent: string | null;
  instrument_code: string;
  action: string;
  confidence: number;
  expected_value: number | null;
  rationale: string;
  feature_vector_json: string | null;
  risk_snapshot_json: string | null;
  raw_signal_json: string | null;
  latency_ms: number | null;
  created_at: string;
}

export interface TraceTelemetryRow {
  id: number;
  event_type: string;
  source: string;
  message: string;
  telemetry_json: string | null;
  created_at: string;
}

export interface AttributionRow extends TradeHistoryRow {
  rationale: string | null;
  confidence: number | null;
}

export interface VaultUpdateRequest {
  keyName?: string;
  secret?: string;
  metadata?: JsonRecord;
  rotationReason?: string;
}

export interface AlertTestRequest {
  priority?: AlertPriority;
  title?: string;
  message?: string;
  dedupeKey?: string;
  metadata?: JsonRecord;
}

export interface NotificationSettingsRequest {
  notifications?: NotificationSettingsUpdate;
}

export interface DateRangeFilter {
  from: string | null;
  to: string | null;
}
