import { z } from "zod";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertAdmin } from "@/lib/authz/assert";
import { setClientArchived } from "@/lib/clients/archive";
import { jsonOk, parseBody, withApiHandler } from "@/lib/api/response";

const bodySchema = z.object({ archived: z.boolean() });

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/clients/:id/archive  { archived: true | false }
 * Archive hides the client everywhere in the portal but deletes nothing;
 * { archived: false } restores it. Admin only.
 */
export async function POST(request: Request, context: RouteContext) {
  return withApiHandler(async () => {
    const { id } = await context.params;
    const user = await getCurrentUser();
    assertAuthenticated(user);
    assertAdmin(user);
    const { archived } = await parseBody(request, bodySchema);
    return jsonOk({ client: await setClientArchived(id, archived) });
  });
}
