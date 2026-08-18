import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { getTask } from "@/lib/agent/task-runner";
import { jsonOk, withApiHandler } from "@/lib/api/response";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  return withApiHandler(async () => {
    const { id } = await context.params;
    const user = await getCurrentUser();
    assertAuthenticated(user);

    const task = await getTask(id);
    await assertClientAccess(user.id, task.client_id);
    return jsonOk({ task });
  });
}
