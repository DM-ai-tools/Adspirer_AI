import { z } from "zod";
import { jsonOk, withApiHandler } from "@/lib/api/response";
import { assertClientExists, parseSafeBody, requireAdmin } from "@/lib/shopify/route-helpers";
import { syncShopify } from "@/lib/shopify/sync";

export const maxDuration = 800;

const bodySchema = z.object({ clientId: z.string().min(1) }).strict();

/** Runs a Shopify sync for one client and returns the counts. */
export async function POST(request: Request) {
  return withApiHandler(async () => {
    await requireAdmin();
    const { clientId } = await parseSafeBody(request, bodySchema);
    await assertClientExists(clientId);
    return jsonOk(await syncShopify(clientId));
  });
}
