import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { jsonOk, withApiHandler } from "@/lib/api/response";
import {
  parseCompetitorWorkbook,
  upsertImportedCompetitors,
} from "@/lib/competitors/import-service";

/**
 * POST /api/v2/competitors/upload
 * multipart/form-data:
 * - clientId: string
 * - file: .xlsx/.xls/.csv
 */
export async function POST(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    const form = await request.formData();
    const clientId = String(form.get("clientId") ?? "").trim();
    if (!clientId) throw new Error("clientId is required");
    await assertClientAccess(user.id, clientId);

    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new Error("Upload file is required");
    }
    const rows = parseCompetitorWorkbook(await file.arrayBuffer());
    if (!rows.length) {
      throw new Error(
        "No competitor rows found. Include at least a 'name' column.",
      );
    }
    const result = await upsertImportedCompetitors({ clientId, rows });
    return jsonOk({
      clientId,
      importedRows: rows.length,
      ...result,
    });
  });
}

