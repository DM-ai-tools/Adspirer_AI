import { z } from "zod";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertAdmin } from "@/lib/authz/assert";
import { USER_ROLES } from "@/types";
import { appBaseUrl, inviteMember, listMembers } from "@/lib/team/members";
import { jsonOk, parseBody, withApiHandler } from "@/lib/api/response";

const inviteSchema = z.object({
  email: z.string().trim().email(),
  fullName: z.string().trim().max(120).optional(),
  role: z.enum([USER_ROLES.ADMIN, USER_ROLES.OPERATOR]).default("operator"),
  /** Operators only: the clients they may see. */
  clientIds: z.array(z.string().min(1)).default([]),
});

/** Team members with status, last sign-in and client access (admins only). */
export async function GET() {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    assertAdmin(user);
    return jsonOk({ members: await listMembers() });
  });
}

/** Invite someone by email with a role; emails them a one-time sign-in link. */
export async function POST(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    assertAdmin(user);
    const body = await parseBody(request, inviteSchema);
    const result = await inviteMember({
      email: body.email,
      fullName: body.fullName ?? null,
      role: body.role,
      clientIds: body.clientIds,
      invitedBy: user.profile,
      baseUrl: appBaseUrl(request),
    });
    return jsonOk(result, 201);
  });
}
