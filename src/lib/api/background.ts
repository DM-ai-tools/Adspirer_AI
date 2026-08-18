import { after } from "next/server";
import { logger } from "@/lib/observability/logger";

/**
 * Run work that has to outlive the response that scheduled it.
 *
 * GPT Image takes 30–90s per still, so awaiting a batch inside the request
 * would pin the operator to the page: navigating away aborts the fetch and
 * strands half-generated drafts. `after` hands the work to the server for up
 * to the route's `maxDuration`. The fallback covers callers that are already
 * outside a request scope, such as work started from a streamed response body,
 * where dropping the job outright would be worse than an unsupervised promise.
 */
export function runAfterResponse(
  label: string,
  work: () => Promise<unknown>,
): void {
  const guarded = async () => {
    try {
      await work();
    } catch (error) {
      logger.error("Background work failed", {
        label,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  try {
    after(guarded);
  } catch {
    void guarded();
  }
}
