import { handleRequest } from "./api";
import { runScheduledGeneration } from "./autonomy";
import type { Env } from "./env";
import { refreshNextSource } from "./ingest";
import { reconcileOfficialPayouts } from "./payouts";
import { refreshExpectedResult } from "./result-freshness";
import { gradeShadowTrials, recoverShadowTrials } from "./shadow";

export { handleRequest } from "./api";
export { dashboardAccess } from "./access";
export {
  deriveProtectedDailySeed,
  deterministicDailySeed,
  generateForGame,
  generationRunById,
  listGeneratedRuns,
  readServiceStatus,
  runScheduledGeneration
} from "./autonomy";
export { claimDelivery, completeDelivery, parseDeliveryResult } from "./delivery";
export { refreshNextSource, refreshSource } from "./ingest";
export {
  appendGradeSettlement,
  appendLedgerEntry,
  appendLedgerEligibilityEvent,
  appendPurchaseConfirmation,
  gradeAvailableLedgerEntries,
  gradeTicket,
  listTicketLabEntries,
  queueGradingFailureAlert,
  readTrackRecord,
  reconcileLedgerEligibility,
  reconcileLegacyRandomBaselines,
  reconcileResultNotifications,
  TICKET_LAB_DISCLAIMER
} from "./ticket-lab";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const scheduledAt = new Date(controller.scheduledTime);
    const outcome = await runScheduledGeneration(env, scheduledAt);
    const failures: string[] = [];
    const maintain = async (name: string, work: () => Promise<unknown>): Promise<void> => {
      try {
        await work();
      } catch (error) {
        const message = `${name}: ${String(error).slice(0, 500)}`;
        failures.push(message);
        console.error(
          JSON.stringify({ service: "rabbitholetx", event: "maintenance_failed", message })
        );
      }
    };
    if (outcome.kind === "idle") {
      // Missing expected results take priority over the round-robin archive refresh.
      await maintain("expected-results", async () => {
        const refreshed = await refreshExpectedResult(env, new Date());
        if (!refreshed && scheduledAt.getUTCMinutes() % 30 === 0) await refreshNextSource(env);
      });
    }
    await maintain("official-payouts", () => reconcileOfficialPayouts(env, null, new Date()));
    await maintain("shadow-capture", () => recoverShadowTrials(env, new Date()));
    await maintain("shadow-grading", () => gradeShadowTrials(env, null, new Date()));
    if (outcome.kind === "failed") {
      throw new Error(
        `Autonomous generation failed for ${outcome.game}/${outcome.drawDate}: ${outcome.error}`
      );
    }
    if (failures.length) throw new Error(failures.join("; "));
  }
} satisfies ExportedHandler<Env>;
