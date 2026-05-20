import {
  ProfilerAgent,
  PROFILER_STATE_STORAGE_PREFIX,
  type ProfilerAgentConfig
} from "./ProfilerAgent";
import {
  DEFAULT_PROFILER_ALERT_THRESHOLD,
  DEFAULT_PROFILER_BUCKET_VOLUME,
  DEFAULT_PROFILER_ROLLING_WINDOW,
  DEFAULT_QUOTE_HIBERNATE_MS,
  DEFAULT_WHALE_PRINT_Z_THRESHOLD,
  TARGET_ASSET_MATRIX
} from "../TradingEngineConstants";
import {
  isTargetInstrument,
  normalizeNativeInstrumentCode,
  profilerInstrumentFromStorageKey,
  readBoundedNumber,
  readPositiveInteger,
  readPositiveNumber
} from "../engine/trading/helpers/RuntimeHelpers";
import type { Env, GlobalRiskConfig, ProfilerState } from "../types";

export class ProfilerRegistry {
  readonly agents = new Map<string, ProfilerAgent>();

  constructor(
    private readonly env: Env,
    private readonly primaryAgent: ProfilerAgent,
    private readonly currentConfig: () => GlobalRiskConfig
  ) {
    this.agents.set("btc-usd", primaryAgent);
  }

  forInstrument(instrumentCode: string): ProfilerAgent {
    const normalized = normalizeNativeInstrumentCode(instrumentCode);
    const existing = this.agents.get(normalized);

    if (existing) {
      return existing;
    }

    const agent = normalized === "btc-usd" ? this.primaryAgent : this.createAgent();
    agent.configure(this.currentConfig());
    this.agents.set(normalized, agent);
    return agent;
  }

  hydrate(
    legacyState: ProfilerState | undefined,
    persistedStates: Map<string, ProfilerState>
  ): void {
    this.agents.clear();
    this.primaryAgent.hydrate(legacyState);
    this.agents.set("btc-usd", this.primaryAgent);

    for (const [storageKey, state] of persistedStates) {
      const instrumentCode = profilerInstrumentFromStorageKey(storageKey);
      if (!isTargetInstrument(instrumentCode)) {
        continue;
      }

      const agent = instrumentCode === "btc-usd" ? this.primaryAgent : this.createAgent();
      agent.hydrate(state);
      this.agents.set(instrumentCode, agent);
    }

    this.ensureTargetAgents();
  }

  reset(): void {
    this.agents.clear();
    this.primaryAgent.hydrate(null);
    this.primaryAgent.configure(this.currentConfig());
    this.agents.set("btc-usd", this.primaryAgent);

    for (const asset of TARGET_ASSET_MATRIX) {
      const agent = this.forInstrument(asset.instrumentCode);
      agent.hydrate(null);
      agent.configure(this.currentConfig());
    }
  }

  async deleteRetiredStorage(
    storage: DurableObjectStorage,
    onFailure: (reason: string, error: unknown) => void
  ): Promise<string[]> {
    const retiredKeys: string[] = [];

    for (const instrumentCode of [...this.agents.keys()]) {
      if (!isTargetInstrument(instrumentCode)) {
        this.agents.delete(instrumentCode);
      }
    }

    try {
      const stored = await storage.list<ProfilerState>({
        prefix: PROFILER_STATE_STORAGE_PREFIX
      });
      for (const key of stored.keys()) {
        if (!isTargetInstrument(profilerInstrumentFromStorageKey(key))) {
          retiredKeys.push(key);
        }
      }
      if (retiredKeys.length > 0) {
        await storage.delete(retiredKeys);
      }
    } catch (error) {
      onFailure("RETIRED_PROFILER_STORAGE_DELETE", error);
    }

    return retiredKeys;
  }

  configure(config: GlobalRiskConfig): void {
    this.primaryAgent.configure(config);
    for (const agent of this.agents.values()) {
      agent.configure(config);
    }
  }

  snapshot(
    overrideInstrument?: string,
    overrideState?: ProfilerState
  ): Record<string, ProfilerState> {
    const entries: [string, ProfilerState][] = [];

    for (const asset of TARGET_ASSET_MATRIX) {
      entries.push([asset.instrumentCode, this.forInstrument(asset.instrumentCode).snapshot()]);
    }

    if (overrideInstrument && overrideState) {
      const normalized = normalizeNativeInstrumentCode(overrideInstrument);
      if (!isTargetInstrument(normalized)) {
        return Object.fromEntries(entries);
      }

      const index = entries.findIndex(([instrumentCode]) => instrumentCode === normalized);
      if (index >= 0) {
        entries[index] = [normalized, overrideState];
      } else {
        entries.push([normalized, overrideState]);
      }
    }

    return Object.fromEntries(entries);
  }

  maxToxicity(): number {
    let max = this.primaryAgent.toxicityScore;
    for (const agent of this.agents.values()) {
      max = Math.max(max, agent.toxicityScore);
    }
    return max;
  }

  entries(): IterableIterator<[string, ProfilerAgent]> {
    return this.agents.entries();
  }

  private ensureTargetAgents(): void {
    for (const asset of TARGET_ASSET_MATRIX) {
      this.forInstrument(asset.instrumentCode);
    }
  }

  private createAgent(): ProfilerAgent {
    return createProfilerAgentFromEnv(this.env);
  }
}

export function createProfilerAgentFromEnv(env: Env): ProfilerAgent {
  return new ProfilerAgent(profilerConfigFromEnv(env));
}

function profilerConfigFromEnv(env: Env): ProfilerAgentConfig {
  return {
    bucketSize: readPositiveNumber(env.PROFILER_BUCKET_VOLUME, DEFAULT_PROFILER_BUCKET_VOLUME),
    rollingWindow: readPositiveInteger(
      env.PROFILER_ROLLING_WINDOW,
      DEFAULT_PROFILER_ROLLING_WINDOW,
      1,
      500
    ),
    alertThreshold: readBoundedNumber(
      env.PROFILER_ALERT_THRESHOLD,
      DEFAULT_PROFILER_ALERT_THRESHOLD,
      0,
      1
    ),
    whalePrintZThreshold: readPositiveNumber(
      env.WHALE_PRINT_Z_THRESHOLD,
      DEFAULT_WHALE_PRINT_Z_THRESHOLD
    ),
    quoteHibernateMs: readPositiveInteger(
      env.QUOTE_HIBERNATE_MS,
      DEFAULT_QUOTE_HIBERNATE_MS,
      100,
      60_000
    )
  };
}
