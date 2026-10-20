import { getConfig } from "@/lib/config";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAdmin, assertAuthenticated } from "@/lib/authz/assert";
import { jsonOk, withApiHandler } from "@/lib/api/response";
import {
  GoogleReconnectRequired,
  getGoogleAccessToken,
  loadGoogleConnection,
} from "@/lib/google/oauth";

/** Connection state for the admin page. Explicit fields only: no token ever leaves the server. */
export async function GET() {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    assertAdmin(user);

    const config = getConfig();
    const connection = await loadGoogleConnection();

    let needsReconnect = false;
    if (connection) {
      try {
        await getGoogleAccessToken();
      } catch (error) {
        needsReconnect = error instanceof GoogleReconnectRequired;
      }
    }

    // DEMO_MODE runs on the mock Google provider, so Google counts as configured there.
    return jsonOk({
      configured: config.isDemoMode || config.hasGoogle,
      adsConfigured: config.isDemoMode || config.hasGoogleAds,
      connected: Boolean(connection),
      email: connection?.google_email ?? null,
      needsReconnect,
      connectedAt: connection?.connected_at ?? null,
    });
  });
}
