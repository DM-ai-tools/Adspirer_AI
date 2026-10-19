import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { ValidationError } from "@/lib/errors";
import {
  applyCategoryImport,
  parseCategorySheet,
} from "@/lib/clients/category-import";
import { jsonOk, withApiHandler } from "@/lib/api/response";

type RouteContext = { params: Promise<{ id: string }> };

const MAX_BYTES = 5 * 1024 * 1024;

/**
 * POST /api/clients/:id/services/import
 * multipart/form-data:
 * - file: .xlsx/.xls/.csv
 * - mode: "merge" (default) | "replace"
 */
export async function POST(request: Request, context: RouteContext) {
  return withApiHandler(async () => {
    const { id } = await context.params;
    const user = await getCurrentUser();
    assertAuthenticated(user);
    await assertClientAccess(user.id, id);

    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new ValidationError("Upload file is required");
    }
    if (file.size > MAX_BYTES) {
      throw new ValidationError("File is too large (5 MB maximum)");
    }
    const mode = String(form.get("mode") ?? "merge");
    if (mode !== "merge" && mode !== "replace") {
      throw new ValidationError('mode must be "merge" or "replace"');
    }

    const { rows, errors, columns } = parseCategorySheet(
      await file.arrayBuffer(),
      file.name,
    );
    if (!rows.length) {
      throw new ValidationError(
        errors[0] ?? "No category rows found in the file",
        { errors },
      );
    }
    const { created, updated } = await applyCategoryImport(id, rows, mode, columns);
    return jsonOk({ created, updated, errors });
  });
}
