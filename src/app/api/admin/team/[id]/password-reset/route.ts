import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertAdmin } from "@/lib/authz/assert";
import { appBaseUrl, sendPasswordReset } from "@/lib/team/members";
import { jsonOk, withApiHandler } from "@/lib/api/response";

type RouteContext = { params: Promise<{ id: string }> };

/** Email a link to set a new password (passwords are never shown to admins). */
export async function POST(request: Request, context: RouteContext) {
  return withApiHandler(async () => {
    const { id } = await context.params;
    const user = await getCurrentUser();
    assertAuthenticated(user);
    assertAdmin(user);
    return jsonOk(await sendPasswordReset(id, user.profile, appBaseUrl(request)));
  });
}
