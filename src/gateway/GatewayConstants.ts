export const DEFAULT_ADMIN_PAGE_SIZE = 100;
export const MAX_ADMIN_PAGE_SIZE = 500;
export const ENGINE_HEALTH_TIMEOUT_MS = 1_500;
export const MOLTWORKER_HEARTBEAT_KEY = "moltworker:heartbeat";
export const DEFAULT_MOLTWORKER_HEARTBEAT_MAX_AGE_MS = 300_000;
export const PAPER_SESSION_STARTED_AT_KEY = "paper:session_started_at";
export const CASCADE_PAPER_ARMED_AT_KEY = "cascade:paper_armed_at";
export const CASCADE_LAST_CONFIG_CHANGE_AT_KEY = "cascade:last_config_change_at";
export const CASCADE_LAST_BACKTEST_REPORT_KEY = "cascade:last_backtest_report";
export const CASCADE_TWO_PERSON_READ_APPROVAL_KEY = "cascade:two_person:read_approval";
export const CASCADE_TWO_PERSON_APPROVAL_WINDOW_MS = 5 * 60_000;
export const CASCADE_CONFIG_FREEZE_HOURS = 72;
export const COST_BUDGET_SETTINGS_KEY = "cost_budget_settings";
export const JWT_REVOCATION_PREFIX = "auth:jti:revoked:";
export const ACTIVE_TOKEN_PREFIX = "auth:active:";

export const LOG_LEVELS = ["DEBUG", "INFO", "WARN", "ERROR", "CRITICAL"] as const;

export const AGENT_NAMES = [
  "ORACLE",
  "SENTIMENT",
  "PROFILER",
  "CROUPIER",
  "PIT_BOSS",
  "JANITOR",
  "EXECUTIONER",
  "MOLTWORKER",
  "RISK",
  "SYSTEM"
] as const;

export const TRADE_STATUSES = [
  "ACCEPTED",
  "FILLED",
  "PARTIAL",
  "REJECTED",
  "CANCELLED",
  "GHOST_FILL"
] as const;
