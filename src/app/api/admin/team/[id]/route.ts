import { z } from "zod";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertAdmin } from "@/lib/authz/assert";
import { USER_ROLES } from "@/types";
import { setMemberActive, updateMember } from "@/lib/team/members";
import { jsonOk, parseBody, withApiHandler } from "@/lib/api/response";

const patchSchema = z.object({
  role: z.enum([USER_ROLES.ADMIN, USER_ROLES.OPERATOR]).optional(),
  fullName: z.string().trim().min(1).max(120).nullable().optional(),
  clientIds: z.array(z.string().min(1)).optional(),
  isActive: z.boolean().optional(),
});

type RouteContext = { params: Promise<{ id: string }> };

/** Change a member's role, name, client access, or active state. */
export async function PATCH(request: Request, context: RouteContext) {
  return withApiHandler(async () => {
    const { id } = await context.params;
    const user = await getCurrentUser();
    assertAuthenticated(user);
    assertAdmin(user);
    const body = await parseBody(request, patchSchema);
    let member =
      body.role !== undefined || body.fullName !== undefined || body.clientIds !== undefined
        ? await updateMember(id, { role: body.role, fullName: body.fullName, clientIds: body.clientIds }, user.profile)
        : null;
    if (body.isActive !== undefined) member = await setMemberActive(id, body.isActive, user.profile);
    return jsonOk({ member });
  });
}

/** Deactivate (members are never hard-deleted, so their history stays attributed). */
export async function DELETE(_request: Request, context: RouteContext) {
  return withApiHandler(async () => {
    const { id } = await context.params;
    const user = await getCurrentUser();
    assertAuthenticated(user);
    assertAdmin(user);
    return jsonOk({ member: await setMemberActive(id, false, user.profile), disabled: true });
  });
}
