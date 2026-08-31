import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { getLiveAdspirerProvider, getProvider, resolveProvider } from "@/lib/adspirer/client";
import { resolvePrimaryAccountId } from "@/lib/agent/adspirer-agent";
import { jsonOk, withApiHandler } from "@/lib/api/response";
import { getWorkspaceContext } from "@/lib/runtime/workspace-context";

/**
 * GET /api/meta/audiences?clientId=…
 * Lists custom audiences for the client's mapped Meta account.
 */
export async function GET(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    const url = new URL(request.url);
    const clientId = url.searchParams.get("clientId");
    if (!clientId) throw new Error("clientId required");
    await assertClientAccess(user.id, clientId);

    const accountId =
      url.searchParams.get("accountId") ||
      (await resolvePrimaryAccountId(clientId));
    if (!accountId) {
      throw new Error(
        "No Meta ad account is mapped to this client. Connect Facebook in Workspace V2 or map an account under Adspirer Connection.",
      );
    }

    const provider =
      getWorkspaceContext()?.version === "v2"
        ? await resolveProvider()
        : getLiveAdspirerProvider() ?? getProvider();
    if (!provider.listCustomAudiences) {
      throw new Error("Custom audience listing is not available on this provider");
    }
    const audiences = await provider.listCustomAudiences(accountId);
    return jsonOk({ accountId, audiences });
  });
}
