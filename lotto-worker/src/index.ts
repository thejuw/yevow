import { handleRequest } from "./api";
import { runScheduledGeneration } from "./autonomy";
import type { Env } from "./env";
import { refreshNextSource } from "./ingest";

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
    if (outcome.kind === "idle") {
      // The ten-minute trigger gives six-game draw days enough bounded work slots.
      // Outside generation work, retain the established 30-minute archive cadence.
      if (scheduledAt.getUTCMinutes() % 30 === 0) await refreshNextSource(env);
      return;
    }
    if (outcome.kind === "failed") {
      throw new Error(
        `Autonomous generation failed for ${outcome.game}/${outcome.drawDate}: ${outcome.error}`
      );
    }
  }
} satisfies ExportedHandler<Env>;
