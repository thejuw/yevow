import { generateTickets } from "../lib/lotto/picker";
import type { GenerateTicketsInput, PickResult } from "../lib/lotto/types";

type PickerWorkerResponse =
  | { readonly ok: true; readonly result: PickResult }
  | { readonly ok: false; readonly error: string };

const workerScope = self as unknown as {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<GenerateTicketsInput>) => void
  ): void;
  postMessage(message: PickerWorkerResponse): void;
};

workerScope.addEventListener("message", (event) => {
  try {
    workerScope.postMessage({ ok: true, result: generateTickets(event.data) });
  } catch (error) {
    workerScope.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : "The ticket set could not be generated."
    });
  }
});
