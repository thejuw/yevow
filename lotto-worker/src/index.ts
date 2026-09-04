import { handleRequest } from "./api";
import type { Env } from "./env";
import { refreshNextSource } from "./ingest";

export { handleRequest } from "./api";
export { refreshNextSource, refreshSource } from "./ingest";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await refreshNextSource(env);
  }
} satisfies ExportedHandler<Env>;
