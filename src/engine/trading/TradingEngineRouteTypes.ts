import type { LatencyMetrics, InternalOrderBook } from "../../types";

export interface TickIngestResult {
  accepted: boolean;
  status:
    | LatencyMetrics["status"]
    | "DISABLED"
    | "ANOMALY_PAUSE"
    | "DESYNC"
    | "DUPLICATE_OR_OUT_OF_ORDER"
    | "IGNORED"
    | "STALE_DROPPED"
    | "BOOK_NOT_READY";
  reason?: string;
  processedCount?: number;
  metrics?: LatencyMetrics;
  book?: InternalOrderBook;
}

export interface GrpcFatalDropPayload {
  streamId?: string;
  source?: string;
  source_exchange?: string;
  connectionId?: string | null;
  reason?: string;
  disconnectedForMs?: number;
  thresholdMs?: number;
  observedAt?: string;
}
