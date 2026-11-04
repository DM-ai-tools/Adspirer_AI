import { z } from "zod";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { jsonOk, withApiHandler } from "@/lib/api/response";
import { getCatalogReport } from "@/lib/meta/catalog/service";

const querySchema = z.object({ clientId: z.string().min(1), catalogId: z.string().min(1) });

/** GET /api/commerce/:catalogId?clientId=… — findings and evidence for one of the client's catalogues. */
export async function GET(request: Request, ctx: { params: Promise<{ catalogId: string }> }) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    const { catalogId } = await ctx.params;
    const url = new URL(request.url);
    const query = querySchema.parse({ clientId: url.searchParams.get("clientId") ?? undefined, catalogId });
    await assertClientAccess(user.id, query.clientId);
    return jsonOk(await getCatalogReport(query.clientId, query.catalogId));
  });
}
