import { z } from "zod";
import { jsonOk, withApiHandler } from "@/lib/api/response";
import { assertClientExists, parseSafeBody, requireAdmin } from "@/lib/shopify/route-helpers";
import { connectShopify } from "@/lib/shopify/sync";

const bodySchema = z.object({
  clientId: z.string().min(1),
  shopDomain: z.string().min(1),
  accessToken: z.string().min(1),
}).strict();

/** Connects a client's Shopify store (token paste). The token is never echoed back. */
export async function POST(request: Request) {
  return withApiHandler(async () => {
    const user = await requireAdmin();
    const body = await parseSafeBody(request, bodySchema);
    await assertClientExists(body.clientId);
    const result = await connectShopify({ ...body, connectedBy: user.id });
    return jsonOk({ shopName: result.shopName, currency: result.currency });
  });
}
