import { evaluateSharedTickGate, type TickGateInput } from "./SharedTickGate";

export interface PipelineResult {
  accepted: boolean;
  strategy: "MARKET_MAKING" | "CASCADE_RECOVERY";
  processedTicks: number;
  reason: string;
}

export class MarketMakingPipeline {
  private processedTicks = 0;

  handleTick(gateInput: TickGateInput): PipelineResult {
    const gate = evaluateSharedTickGate(gateInput);

    if (!gate.ok) {
      return {
        accepted: false,
        strategy: "MARKET_MAKING",
        processedTicks: this.processedTicks,
        reason: gate.reason
      };
    }

    this.processedTicks += 1;
    return {
      accepted: true,
      strategy: "MARKET_MAKING",
      processedTicks: this.processedTicks,
      reason: "OK"
    };
  }
}
