import { z } from "zod";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { jsonOk, parseBody, withApiHandler } from "@/lib/api/response";
import { queueCatalogFix } from "@/lib/meta/catalog/queue-fix";

// Unknown keys (such as a client-supplied filter or args) are stripped; the fix comes from the server-side report.
const bodySchema = z.object({
  clientId: z.string().min(1),
  catalogId: z.string().min(1),
  findingId: z.string().min(1),
});

/** POST /api/commerce/fixes — queues one finding's fix for approval and returns the approval id. */
export async function POST(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    const body = await parseBody(request, bodySchema);
    await assertClientAccess(user.id, body.clientId);
    const result = await queueCatalogFix({ ...body, userId: user.id });
    return result.ok ? jsonOk({ approvalId: result.approvalId }) : jsonOk(result.report);
  });
}
