import { z } from "zod";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { edit, getApproval } from "@/lib/approvals/service";
import { jsonOk, parseBody, withApiHandler } from "@/lib/api/response";

const bodySchema = z.object({
  editableInput: z.record(z.string(), z.unknown()),
  notes: z.string().optional(),
  budgetImpactCents: z.number().int().nullable().optional(),
});

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  return withApiHandler(async () => {
    const { id } = await context.params;
    const user = await getCurrentUser();
    assertAuthenticated(user);

    const existing = await getApproval(id);
    await assertClientAccess(user.id, existing.client_id);

    const body = await parseBody(request, bodySchema);
    const editedArgs = body.notes
      ? { ...body.editableInput, _notes: body.notes }
      : body.editableInput;

    const approval = await edit({
      approvalId: id,
      reviewedBy: user.id,
      editedArgs,
      budgetImpactCents: body.budgetImpactCents,
    });

    return jsonOk({ approval });
  });
}
