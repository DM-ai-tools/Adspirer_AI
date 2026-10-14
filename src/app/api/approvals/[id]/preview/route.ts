import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { getApproval } from "@/lib/approvals/service";
import { previewApproval } from "@/lib/approvals/preview";
import { jsonOk, withApiHandler } from "@/lib/api/response";

type RouteContext = { params: Promise<{ id: string }> };

/** Meta's preview of the ad this approval would create (nothing is created). */
export async function GET(_request: Request, context: RouteContext) {
  return withApiHandler(async () => {
    const { id } = await context.params;
    const user = await getCurrentUser();
    assertAuthenticated(user);
    const approval = await getApproval(id);
    await assertClientAccess(user.id, approval.client_id);
    return jsonOk(await previewApproval(approval));
  });
}
