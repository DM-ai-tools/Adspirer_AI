import { z } from "zod";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { jsonOk, withApiHandler } from "@/lib/api/response";
import { listClientCatalogProducts } from "@/lib/meta/catalog/service";

const querySchema = z.object({
  clientId: z.string().min(1),
  catalogId: z.string().min(1),
  issue: z.enum(["out_of_stock", "rejected", "any_error"]).optional(),
  after: z.string().min(1).optional(),
});

/** GET /api/commerce/:catalogId/products?clientId=…&issue=…&after=… — one page of the catalogue's products. */
export async function GET(request: Request, ctx: { params: Promise<{ catalogId: string }> }) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    const { catalogId } = await ctx.params;
    const url = new URL(request.url);
    const query = querySchema.parse({
      clientId: url.searchParams.get("clientId") ?? undefined,
      catalogId,
      issue: url.searchParams.get("issue") ?? undefined,
      after: url.searchParams.get("after") ?? undefined,
    });
    await assertClientAccess(user.id, query.clientId);
    return jsonOk(
      await listClientCatalogProducts(query.clientId, query.catalogId, {
        issue: query.issue,
        after: query.after,
      }),
    );
  });
}
