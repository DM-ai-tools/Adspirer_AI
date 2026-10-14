import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { getChange } from "@/lib/changes/change-log";
import { rollbackChange } from "@/lib/changes/rollback";
import { ApprovalValidationError } from "@/lib/errors";
import { jsonOk, withApiHandler } from "@/lib/api/response";

/** Rolling back runs the inverse change against Meta, like approving does. */
export const maxDuration = 120;

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(_request: Request, context: RouteContext) {
  return withApiHandler(async () => {
    const { id } = await context.params;
    const user = await getCurrentUser();
    assertAuthenticated(user);
    const change = await getChange(id);
    if (!change) throw new ApprovalValidationError(`Change ${id} was not found.`);
    await assertClientAccess(user.id, change.client_id);
    const { approval } = await rollbackChange({ changeId: id, userId: user.id });
    return jsonOk({ approval });
  });
}
