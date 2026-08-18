import { cookies } from "next/headers";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { DEMO_USER_COOKIE } from "@/lib/security/auth";
import { AuthorizationError } from "@/lib/errors";
import { jsonOk, parseBody, withApiHandler } from "@/lib/api/response";

const bodySchema = z.object({
  email: z.string().email(),
});

export async function POST(request: Request) {
  return withApiHandler(async () => {
    const config = getConfig();
    if (!config.isDemoMode && config.hasSupabase) {
      throw new AuthorizationError("Demo login is only available in DEMO_MODE", {
        statusHint: 403,
      });
    }

    const body = await parseBody(request, bodySchema);
    const store = getDemoStore();
    const profile = store.profiles.find(
      (p) => p.email.toLowerCase() === body.email.toLowerCase() && p.is_active,
    );
    if (!profile) {
      throw new Error(`Demo user not found: ${body.email}`);
    }

    const cookieStore = await cookies();
    cookieStore.set(DEMO_USER_COOKIE, profile.email, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });

    return jsonOk({
      user: {
        id: profile.id,
        email: profile.email,
        profile,
      },
    });
  });
}
