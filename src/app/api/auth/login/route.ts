import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
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
        "Supabase login is disabled while DEMO_MODE is on. Set DEMO_MODE=false.",
        { statusHint: 400 },
      );
    }

    const body = await parseBody(request, bodySchema);
    const supabase = await createClient();
    let { data, error } = await supabase.auth.signInWithPassword({
      email: body.email,
      password: body.password,
    });

    // Common Supabase gotcha: Confirm email is ON → unconfirmed users get
    // "Invalid login credentials". Auto-confirm existing user once, then retry.
    if (error && /invalid login credentials/i.test(error.message)) {
      const admin = createAdminClient();
      const existing = await findUserByEmail(admin, body.email);
      if (existing && !existing.email_confirmed_at) {
        await admin.auth.admin.updateUserById(existing.id, {
          email_confirm: true,
        });
        const retry = await supabase.auth.signInWithPassword({
          email: body.email,
          password: body.password,
        });
        data = retry.data;
        error = retry.error;
      }
    }

    if (error || !data.user) {
      throw new AuthorizationError(
        error?.message === "Invalid login credentials"
          ? "Invalid email or password. If you just registered, use Register again to recover the account, or reset the password in Supabase Auth."
          : (error?.message ?? "Invalid email or password"),
        { statusHint: 401 },
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

async function findUserByEmail(
  admin: ReturnType<typeof createAdminClient>,
  email: string,
) {
  const normalized = email.toLowerCase();
  for (let page = 1; page <= 5; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage: 200,
    });
    if (error) break;
    const found = data.users.find((u) => u.email?.toLowerCase() === normalized);
    if (found) return found;
    if (data.users.length < 200) break;
  }
  return null;
}
