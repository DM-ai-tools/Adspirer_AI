import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { clientGoogleAssets } from "@/lib/google/assets";
import type { GoogleAsset } from "@/lib/google/types";
import { jsonOk, withApiHandler } from "@/lib/api/response";

type RouteContext = { params: Promise<{ clientId: string }> };

const shown = (asset: GoogleAsset | null) =>
  asset ? { name: asset.name, external_id: asset.external_id } : null;

/**
 * GET /api/v2/clients/:clientId/google-assets
 * The GA4 property, Google Ads account and Search Console site mapped to the
 * client. Names and ids only; Google's raw discovery payload stays server-side.
 */
export async function GET(_request: Request, context: RouteContext) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    const { clientId } = await context.params;
    await assertClientAccess(user.id, clientId);

    const { ga4, ads, gsc } = await clientGoogleAssets(clientId);
    return jsonOk({ ga4: shown(ga4), ads: shown(ads), gsc: shown(gsc) });
  });
}
