import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { MAX_DOCUMENT_BYTES } from "@/lib/documents/extract-text";
import { parseDirectionsFile } from "@/lib/creatives/directed/file";
import { jsonOk, withApiHandler } from "@/lib/api/response";

export const maxDuration = 120;

/**
 * multipart: `clientId` and `file` (txt, md, csv, docx, pdf or xlsx). Reads the file into one item per
 * direction, in order, for the operator to check and edit. Nothing is made and nothing is spent.
 */
export async function POST(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    const form = await request.formData();
    const clientId = String(form.get("clientId") ?? "");
    if (!clientId) throw new Error("clientId required");
    await assertClientAccess(user.id, clientId);
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) throw new Error("Choose a directions file to upload.");
    if (file.size > MAX_DOCUMENT_BYTES) throw new Error("File is too large (max 10 MB).");
    const directions = await parseDirectionsFile({ name: file.name, bytes: Buffer.from(await file.arrayBuffer()) });
    return jsonOk({ fileName: file.name, directions });
  });
}
