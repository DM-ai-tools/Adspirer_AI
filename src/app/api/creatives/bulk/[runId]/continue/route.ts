import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { getRun, leaseActive } from "@/lib/creatives/bulk/runs";
import { renderPending } from "@/lib/creatives/bulk/run";
import { runAfterResponse } from "@/lib/api/background";
import { jsonOk, withApiHandler } from "@/lib/api/response";

export const maxDuration = 300;

type Ctx = { params: Promise<{ runId: string }> };

/** Pick up the renders a worker left waiting (it ran out of time, or died). Safe to call repeatedly. */
export async function POST(_request: Request, context: Ctx) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    const { runId } = await context.params;
    const run = await getRun(runId);
    if (!run) throw new Error("Run not found");
    await assertClientAccess(user.id, run.client_id);
    if (run.status !== "rendering" || leaseActive(run)) return jsonOk({ accepted: false });
    runAfterResponse("bulk-creative-continue", () => renderPending(runId));
    return jsonOk({ accepted: true });
  });
}
