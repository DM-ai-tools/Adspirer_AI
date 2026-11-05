import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { getRun } from "@/lib/creatives/bulk/runs";
import { loadRunView } from "@/lib/creatives/bulk/view";
import { jsonOk, withApiHandler } from "@/lib/api/response";

type Ctx = { params: Promise<{ runId: string }> };

export async function GET(_request: Request, context: Ctx) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    const { runId } = await context.params;
    const run = await getRun(runId);
    if (!run) throw new Error("Run not found");
    await assertClientAccess(user.id, run.client_id);
    return jsonOk(await loadRunView(run));
  });
}
