import { GLOBAL_RISK_SETTINGS_KEY, defaultConfig } from "./ConfigManager";
import type { GlobalRiskConfig, JsonRecord, JsonValue } from "./types";

export const ACTIVE_STRATEGY_VERSION_KEY = "strategy_vault:active_version";

export interface StrategyVersion {
  versionId: string;
  name: string;
  description: string | null;
  status: "DRAFT" | "ACTIVE" | "ARCHIVED";
  config: GlobalRiskConfig;
  parameters: JsonRecord;
  performance: JsonRecord | null;
  createdBy: string;
  activatedBy: string | null;
  createdAt: string;
  activatedAt: string | null;
}

export interface StrategyVersionCreateInput {
  name: string;
  description?: string | null;
  config: GlobalRiskConfig;
  parameters?: JsonRecord;
  performance?: JsonRecord | null;
  createdBy: string;
}

interface StrategyVersionRow {
  version_id: string;
  name: string;
  description: string | null;
  status: "DRAFT" | "ACTIVE" | "ARCHIVED";
  config_json: string;
  parameter_json: string;
  performance_json: string | null;
  created_by: string;
  activated_by: string | null;
  created_at: string;
  activated_at: string | null;
}

export class StrategyVault {
  constructor(
    private readonly db: D1Database,
    private readonly configStore: KVNamespace
  ) {}

  async listVersions(limit = 20): Promise<StrategyVersion[]> {
    const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
    const rows = await this.db.prepare(
      `SELECT version_id, name, description, status, config_json, parameter_json,
              performance_json, created_by, activated_by, created_at, activated_at
       FROM strategy_versions
       ORDER BY
         CASE status WHEN 'ACTIVE' THEN 0 WHEN 'DRAFT' THEN 1 ELSE 2 END,
         created_at DESC
       LIMIT ?`
    ).bind(safeLimit).all<StrategyVersionRow>();

    return (rows.results ?? []).map(formatStrategyVersionRow);
  }

  async activeVersion(): Promise<StrategyVersion | null> {
    const activeId = await this.configStore.get(ACTIVE_STRATEGY_VERSION_KEY);
    if (activeId) {
      const byId = await this.readVersion(activeId);
      if (byId) {
        return byId;
      }
    }

    const row = await this.db.prepare(
      `SELECT version_id, name, description, status, config_json, parameter_json,
              performance_json, created_by, activated_by, created_at, activated_at
       FROM strategy_versions
       WHERE status = 'ACTIVE'
       ORDER BY activated_at DESC
       LIMIT 1`
    ).first<StrategyVersionRow>();

    return row ? formatStrategyVersionRow(row) : null;
  }

  async readVersion(versionId: string): Promise<StrategyVersion | null> {
    const row = await this.db.prepare(
      `SELECT version_id, name, description, status, config_json, parameter_json,
              performance_json, created_by, activated_by, created_at, activated_at
       FROM strategy_versions
       WHERE version_id = ?`
    ).bind(versionId).first<StrategyVersionRow>();

    return row ? formatStrategyVersionRow(row) : null;
  }

  async createVersion(input: StrategyVersionCreateInput): Promise<StrategyVersion> {
    const versionId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const config = normalizeStrategyConfig(input.config, versionId, input.createdBy, createdAt);
    const parameters = sanitizeJsonRecord(input.parameters ?? {});
    const performance = input.performance ? sanitizeJsonRecord(input.performance) : null;

    await this.db.prepare(
      `INSERT INTO strategy_versions (
         version_id, name, description, status, config_json, parameter_json,
         performance_json, created_by, created_at
       ) VALUES (?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?)`
    )
      .bind(
        versionId,
        sanitizeText(input.name, "Strategy Version"),
        input.description ? sanitizeText(input.description, null) : null,
        JSON.stringify(config),
        JSON.stringify(parameters),
        performance ? JSON.stringify(performance) : null,
        sanitizeText(input.createdBy, "system"),
        createdAt
      )
      .run();

    const created = await this.readVersion(versionId);
    if (!created) {
      throw new Error("STRATEGY_VERSION_CREATE_FAILED");
    }

    return created;
  }

  async activateVersion(versionId: string, actor: string): Promise<StrategyVersion> {
    const version = await this.readVersion(versionId);
    if (!version) {
      throw new Error("STRATEGY_VERSION_NOT_FOUND");
    }

    const activatedAt = new Date().toISOString();
    const activatedConfig = normalizeStrategyConfig(
      version.config,
      versionId,
      actor,
      activatedAt
    );

    await this.db.batch([
      this.db.prepare("UPDATE strategy_versions SET status = 'ARCHIVED' WHERE status = 'ACTIVE'"),
      this.db.prepare(
        `UPDATE strategy_versions
         SET status = 'ACTIVE', config_json = ?, activated_by = ?, activated_at = ?
         WHERE version_id = ?`
      ).bind(JSON.stringify(activatedConfig), sanitizeText(actor, "system"), activatedAt, versionId)
    ]);

    await this.configStore.put(ACTIVE_STRATEGY_VERSION_KEY, versionId);
    await this.configStore.put(GLOBAL_RISK_SETTINGS_KEY, JSON.stringify(activatedConfig));

    return {
      ...version,
      status: "ACTIVE",
      config: activatedConfig,
      activatedBy: actor,
      activatedAt
    };
  }
}

function formatStrategyVersionRow(row: StrategyVersionRow): StrategyVersion {
  return {
    versionId: row.version_id,
    name: row.name,
    description: row.description,
    status: row.status,
    config: parseJson<GlobalRiskConfig>(row.config_json, defaultConfig),
    parameters: sanitizeJsonRecord(parseJson<JsonRecord>(row.parameter_json, {})),
    performance: row.performance_json
      ? sanitizeJsonRecord(parseJson<JsonRecord>(row.performance_json, {}))
      : null,
    createdBy: row.created_by,
    activatedBy: row.activated_by,
    createdAt: row.created_at,
    activatedAt: row.activated_at
  };
}

function normalizeStrategyConfig(
  config: GlobalRiskConfig,
  versionId: string,
  updatedBy: string,
  updatedAt: string
): GlobalRiskConfig {
  return {
    ...defaultConfig,
    ...config,
    updatedAt,
    updatedBy,
    version: versionId
  };
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function sanitizeJsonRecord(value: JsonRecord): JsonRecord {
  return JSON.parse(JSON.stringify(value)) as JsonRecord;
}

function sanitizeText(value: string, fallback: string | null): string {
  const clean = value.trim().slice(0, 500);
  if (clean.length > 0) {
    return clean;
  }

  if (fallback === null) {
    return "";
  }

  return fallback;
}

export function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
