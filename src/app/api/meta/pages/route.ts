import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { resolvePrimaryAccountId } from "@/lib/agent/adspirer-agent";
import { jsonOk, withApiHandler } from "@/lib/api/response";
import { listFacebookPagesForAccountId } from "@/lib/meta/resolve-page";

/**
 * GET /api/meta/pages?clientId=…&accountId=…
 * Lists Facebook Pages usable for ads on the mapped ad account.
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
        "No Meta ad account is mapped to this client. Connect Facebook in the Workspace header, then map an account under Connections.",
      );
    }

    const pages = await listFacebookPagesForAccountId(accountId);
    return jsonOk({
      accountId,
      pages,
      default_page_id: pages[0]?.id ?? null,
    });
  });
}
