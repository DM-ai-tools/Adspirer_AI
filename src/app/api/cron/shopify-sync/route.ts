import { timingSafeEqual } from "node:crypto";
import { syncAllShopify } from "@/lib/shopify/sync";

export const maxDuration = 800;

/**
 * Scheduled Shopify sync for every connected store: POST /api/cron/shopify-sync with
 * `Authorization: Bearer $CRON_SECRET`. Disabled when CRON_SECRET is unset.
 */
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  const given = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(secret ?? "");
  const ok = Boolean(secret) && a.length === b.length && timingSafeEqual(a, b);
  if (!ok) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return Response.json(await syncAllShopify());
}
