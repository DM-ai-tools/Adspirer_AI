import { getConfig } from "@/lib/config";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertAdmin } from "@/lib/authz/assert";
import { createConnectUrl } from "@/lib/adspirer/oauth";
import { jsonOk, withApiHandler } from "@/lib/api/response";

export async function POST() {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    assertAdmin(user);

    const config = getConfig();
    const redirectUri =
      config.ADSPIRER_REDIRECT_URI ??
      `${config.APP_URL}/api/admin/adspirer/callback`;

    const result = createConnectUrl({
      createdBy: user.id,
      redirectUri,
    });

    return jsonOk({
      url: result.url,
      state: result.state,
      reconnect: true,
    });
  });
}
