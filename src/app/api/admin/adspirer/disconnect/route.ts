import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertAdmin } from "@/lib/authz/assert";
import { disconnectAdspirerServiceAccount } from "@/lib/adspirer/remove-connected-account";
import { jsonOk, withApiHandler } from "@/lib/api/response";

export async function POST() {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    assertAdmin(user);

    await disconnectAdspirerServiceAccount();
    return jsonOk({ disconnected: true });
  });
}
