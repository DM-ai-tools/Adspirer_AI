import { getCurrentUser } from "@/lib/security/auth";
import { assertAdmin, assertAuthenticated } from "@/lib/authz/assert";
import { jsonOk, withApiHandler } from "@/lib/api/response";
import { logger } from "@/lib/observability/logger";
import { decryptToken } from "@/lib/security/token-vault";
import { deleteGoogleConnection, loadGoogleConnection } from "@/lib/google/oauth";

const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

/** Revoke at Google (best effort), then forget the connection. Asset mappings are kept. */
export async function POST() {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    assertAdmin(user);

    try {
      const connection = await loadGoogleConnection();
      if (connection) {
        const res = await fetch(REVOKE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            token: decryptToken(connection.refresh_token_encrypted),
          }).toString(),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) logger.warn("Google token revoke was refused", { status: res.status });
      }
    } catch (error) {
      // Never log the token; the message of a fetch/decrypt failure does not contain it.
      logger.warn("Google token revoke failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }

    await deleteGoogleConnection();
    return jsonOk({ ok: true });
  });
}
