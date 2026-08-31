import { z } from "zod";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { fetchClientMetaCompetitorAds } from "@/lib/competitors/service";
import { jsonOk, parseBody, withApiHandler } from "@/lib/api/response";

const bodySchema = z.object({
  clientId: z.string().min(1),
  serviceId: z.string().optional(),
  competitorName: z.string().optional(),
});

/**
 * POST /api/v2/competitors/ads
 * Returns latest competitor ads from Sociavault for chat card selection.
 */
export async function POST(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    const body = await parseBody(request, bodySchema);
    await assertClientAccess(user.id, body.clientId);

    const intel = await fetchClientMetaCompetitorAds({
      clientId: body.clientId,
      serviceId: body.serviceId,
    });
    const filtered = body.competitorName
      ? intel.filter((row) =>
          row.competitor_name
            .toLowerCase()
            .includes(body.competitorName!.toLowerCase()),
        )
      : intel;

    return jsonOk({
      competitors: filtered,
      ads: filtered.flatMap((c) =>
        c.ads.map((ad) => ({
          competitor_name: c.competitor_name,
          score:
            (ad.is_active ? 30 : 0) +
            (ad.media_type === "video" ? 15 : 10) +
            (ad.cta ? 10 : 0) +
            (ad.landing_url ? 10 : 0),
          ...ad,
        })),
      ),
    });
  });
}

