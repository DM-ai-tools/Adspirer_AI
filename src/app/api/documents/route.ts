import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { jsonOk, withApiHandler } from "@/lib/api/response";
import { listWorkspaceDocuments } from "@/lib/documents/service";

/**
 * GET /api/documents?clientId=&conversationId=
 */
export async function GET(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    const url = new URL(request.url);
    const clientId = String(url.searchParams.get("clientId") ?? "").trim();
    if (!clientId) throw new Error("clientId is required");
    await assertClientAccess(user.id, clientId);

    const conversationId =
      String(url.searchParams.get("conversationId") ?? "").trim() || null;

    const documents = await listWorkspaceDocuments({
      clientId,
      conversationId,
    });
    return jsonOk({ documents });
  });
}
