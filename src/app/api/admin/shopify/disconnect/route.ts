import { z } from "zod";
import { jsonOk, withApiHandler } from "@/lib/api/response";
import { assertClientExists, parseSafeBody, requireAdmin } from "@/lib/shopify/route-helpers";
import { disconnectShopify } from "@/lib/shopify/sync";

const bodySchema = z.object({ clientId: z.string().min(1) }).strict();

/** Removes a client's Shopify connection. */
export async function POST(request: Request) {
  return withApiHandler(async () => {
    await requireAdmin();
    const { clientId } = await parseSafeBody(request, bodySchema);
    await assertClientExists(clientId);
    await disconnectShopify(clientId);
    return jsonOk({ disconnected: true });
  });
}
