import { z } from "zod";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { jsonOk, withApiHandler } from "@/lib/api/response";
import { getClientCommerce } from "@/lib/meta/catalog/service";

const querySchema = z.object({ clientId: z.string().min(1) });

/** GET /api/commerce?clientId=… — the catalogues this client sells from, or a typed failure state. */
export async function GET(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    const url = new URL(request.url);
    const { clientId } = querySchema.parse({ clientId: url.searchParams.get("clientId") ?? undefined });
    await assertClientAccess(user.id, clientId);
    return jsonOk(await getClientCommerce(clientId));
  });
}
