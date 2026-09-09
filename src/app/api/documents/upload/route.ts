import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { jsonOk, withApiHandler } from "@/lib/api/response";
import { uploadWorkspaceDocument, toDocumentListItem } from "@/lib/documents/service";

/**
 * POST /api/documents/upload
 * multipart/form-data: clientId, file, optional conversationId
 */
export async function POST(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    const form = await request.formData();
    const clientId = String(form.get("clientId") ?? "").trim();
    if (!clientId) throw new Error("clientId is required");
    await assertClientAccess(user.id, clientId);

    const conversationId = String(form.get("conversationId") ?? "").trim() || null;
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new Error("Upload file is required");
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const doc = await uploadWorkspaceDocument({
      clientId,
      conversationId,
      uploadedBy: user.id,
      filename: file.name || "document",
      mimeType: file.type || undefined,
      buffer,
    });

    return jsonOk({
      document: toDocumentListItem(doc),
      message: `Uploaded ${doc.filename}. Ask me to summarize it or use it when creating ads/creatives.`,
    });
  });
}
