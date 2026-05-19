import { evaluateSharedTickGate, type TickGateInput } from "./SharedTickGate";
import type { PipelineResult } from "./MarketMakingPipeline";

export class CascadeRecoveryPipeline {
  private processedTicks = 0;

  handleTick(gateInput: TickGateInput): PipelineResult {
    const gate = evaluateSharedTickGate(gateInput);

    if (!gate.ok) {
      return {
        accepted: false,
        strategy: "CASCADE_RECOVERY",
        processedTicks: this.processedTicks,
        reason: gate.reason
      };
    }

    this.processedTicks += 1;
    return {
      accepted: true,
      strategy: "CASCADE_RECOVERY",
      processedTicks: this.processedTicks,
      reason: "OK"
    };
  }
}
