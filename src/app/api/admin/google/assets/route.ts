import { getCurrentUser } from "@/lib/security/auth";
import { assertAdmin, assertAuthenticated } from "@/lib/authz/assert";
import { jsonOk, withApiHandler } from "@/lib/api/response";
import { listGoogleAssets, withoutRawMetadata } from "@/lib/google/assets";

/** Every discovered Google asset and its client mapping, for the admin page. */
export async function GET() {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    assertAdmin(user);

    const assets = await listGoogleAssets();
    return jsonOk({ assets: assets.map(withoutRawMetadata) });
  });
}
