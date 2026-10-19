import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertAdmin } from "@/lib/authz/assert";
import { appBaseUrl, resendInvite } from "@/lib/team/members";
import { jsonOk, withApiHandler } from "@/lib/api/response";

type RouteContext = { params: Promise<{ id: string }> };

/** Send a fresh sign-in link to someone who hasn't accepted their invite yet. */
export async function POST(request: Request, context: RouteContext) {
  return withApiHandler(async () => {
    const { id } = await context.params;
    const user = await getCurrentUser();
    assertAuthenticated(user);
    assertAdmin(user);
    return jsonOk(await resendInvite(id, user.profile, appBaseUrl(request)));
  });
}
