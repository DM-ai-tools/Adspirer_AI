import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { expireStaleTask, getTask } from "@/lib/agent/task-runner";
import { toPublicTask } from "@/lib/agent/task-public";
import { jsonOk, withApiHandler } from "@/lib/api/response";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  return withApiHandler(async () => {
    const { id } = await context.params;
    const user = await getCurrentUser();
    assertAuthenticated(user);

    const task = await getTask(id);
    await assertClientAccess(user.id, task.client_id);
    // A run whose function was killed would otherwise poll as "running" forever.
    const current = await expireStaleTask(task);
    return jsonOk({ task: toPublicTask(current) });
  });
}
