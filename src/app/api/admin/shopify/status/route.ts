import { jsonOk, withApiHandler } from "@/lib/api/response";
import { ValidationError } from "@/lib/errors";
import { assertClientExists, requireAdmin } from "@/lib/shopify/route-helpers";
import { getShopifyStatus } from "@/lib/shopify/sync";

/** GET /api/admin/shopify/status?clientId= */
export async function GET(request: Request) {
  return withApiHandler(async () => {
    await requireAdmin();
    const clientId = new URL(request.url).searchParams.get("clientId")?.trim();
    if (!clientId) throw new ValidationError("clientId is required");
    await assertClientExists(clientId);
    return jsonOk(await getShopifyStatus(clientId));
  });
}
