import { getCurrentUser } from "@/lib/security/auth";
import { assertAdmin, assertAuthenticated } from "@/lib/authz/assert";
import { jsonOk, withApiHandler } from "@/lib/api/response";
import { syncGoogleAssets } from "@/lib/google/assets";

/** Re-discovers the Google assets the connection can see; mappings are kept. */
export async function POST() {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    assertAdmin(user);

    return jsonOk(await syncGoogleAssets());
  });
}
