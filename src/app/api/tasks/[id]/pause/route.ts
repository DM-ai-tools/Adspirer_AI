import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { getTask, pauseTask } from "@/lib/agent/task-runner";
import { jsonOk, withApiHandler } from "@/lib/api/response";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(_request: Request, context: RouteContext) {
  return withApiHandler(async () => {
    const { id } = await context.params;
    const user = await getCurrentUser();
    assertAuthenticated(user);

    const existing = await getTask(id);
    await assertClientAccess(user.id, existing.client_id);

    const task = await pauseTask(id);
    return jsonOk({ task });
  });
}
