import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { jsonOk, withApiHandler } from "@/lib/api/response";
import { deleteWorkspaceDocument } from "@/lib/documents/service";

/**
 * DELETE /api/documents/[id]?clientId=
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    const { id } = await context.params;
    const url = new URL(request.url);
    const clientId = String(url.searchParams.get("clientId") ?? "").trim();
    if (!clientId) throw new Error("clientId is required");
    if (!id) throw new Error("Document id is required");
    await assertClientAccess(user.id, clientId);

    await deleteWorkspaceDocument({ id, clientId });
    return jsonOk({ deleted: true, id });
  });
}
