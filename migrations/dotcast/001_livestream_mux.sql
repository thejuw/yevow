CREATE TABLE IF NOT EXISTS dotcast_livestreams (
  stream_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  control_layer TEXT NOT NULL,
  mux_live_stream_id TEXT NOT NULL UNIQUE,
  playback_id TEXT NOT NULL,
  playback_policy TEXT NOT NULL,
  host_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  mux_status TEXT NOT NULL,
  recording_asset_id TEXT,
  recording_playback_id TEXT,
  low_latency INTEGER NOT NULL DEFAULT 1,
  recording_enabled INTEGER NOT NULL DEFAULT 1,
  reconnect_window_seconds INTEGER NOT NULL DEFAULT 60,
  ingest_rtmp_url TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  stopped_at TEXT,
  archived_at TEXT,
  last_webhook_event_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_dotcast_livestreams_host_updated
  ON dotcast_livestreams (host_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_dotcast_livestreams_status_updated
  ON dotcast_livestreams (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS dotcast_livestream_pool_links (
  stream_id TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  market_id TEXT NOT NULL,
  question TEXT NOT NULL,
  unit TEXT NOT NULL,
  status TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  attached_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (stream_id, pool_id)
);

CREATE INDEX IF NOT EXISTS idx_dotcast_livestream_pool_links_pool
  ON dotcast_livestream_pool_links (pool_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS dotcast_livestream_events (
  event_id TEXT PRIMARY KEY,
  stream_id TEXT NOT NULL,
  mux_live_stream_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  status TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dotcast_livestream_events_stream_created
  ON dotcast_livestream_events (stream_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dotcast_livestream_events_mux_created
  ON dotcast_livestream_events (mux_live_stream_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS dotcast_livestream_events_no_update
BEFORE UPDATE ON dotcast_livestream_events
BEGIN
  SELECT RAISE(ABORT, 'dotcast_livestream_events is append-only');
END;

CREATE TRIGGER IF NOT EXISTS dotcast_livestream_events_no_delete
BEFORE DELETE ON dotcast_livestream_events
BEGIN
  SELECT RAISE(ABORT, 'dotcast_livestream_events is append-only');
END;
