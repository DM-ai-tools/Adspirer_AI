import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getConfig } from "@/lib/config";
import { authUserFromIdentity } from "@/lib/security/auth";
import { AuthorizationError } from "@/lib/errors";
import { jsonOk, parseBody, withApiHandler } from "@/lib/api/response";

const bodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

export async function POST(request: Request) {
  return withApiHandler(async () => {
    const config = getConfig();
    if (config.isDemoMode || !config.hasSupabase) {
      throw new AuthorizationError(
        "Email sign-in is unavailable in demo mode. Use a demo persona, or ask your administrator to enable live sign-in.",
        { statusHint: 400 },
      );
    }

    const body = await parseBody(request, bodySchema);
    const supabase = await createClient();
    const { data, error } = await supabase.auth.signInWithPassword({
      email: body.email,
      password: body.password,
    });

    if (error || !data.user) {
      const raw = error?.message ?? "";
      const unreachable =
        /fetch failed/i.test(raw) ||
        error?.name === "AuthRetryableFetchError" ||
        error?.status === 0;
      throw new AuthorizationError(
        unreachable
          ? "Sign-in service is unreachable. The account host could not be contacted, so the password was not checked."
          : raw === "Invalid login credentials"
            ? "Invalid email or password. Ask your administrator to reset your password if you can't sign in."
            : /email not confirmed/i.test(raw)
              ? "This email hasn't been confirmed yet. Use the link in your invite email, or ask your administrator to resend it."
              : "Sign-in failed. Please try again.",
        { statusHint: unreachable ? 503 : 401 },
      );
    }

    const sessionUser = await authUserFromIdentity({
      id: data.user.id,
      email: data.user.email,
      user_metadata: data.user.user_metadata,
    });
    if (!sessionUser) {
      throw new AuthorizationError("Signed in but profile could not be loaded", {
        statusHint: 500,
      });
    }

    return jsonOk({
      user: {
        id: sessionUser.id,
        email: sessionUser.email,
        profile: sessionUser.profile,
      },
    });
  });
}
