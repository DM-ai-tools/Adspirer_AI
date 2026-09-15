import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getConfig } from "@/lib/config";
import { AuthorizationError } from "@/lib/errors";
import { jsonOk, parseBody, withApiHandler } from "@/lib/api/response";

const bodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  fullName: z.string().min(1).max(120).optional(),
});

/**
 * Register with service-role so the email is confirmed immediately.
 * Avoids "Invalid login credentials" when Supabase has Confirm email enabled.
 */
export async function POST(request: Request) {
  return withApiHandler(async () => {
    const config = getConfig();
    if (config.isDemoMode || !config.hasSupabase) {
      throw new AuthorizationError(
        "Registration is unavailable in demo mode. Ask your administrator to enable live accounts.",
        { statusHint: 400 },
      );
    }

    const body = await parseBody(request, bodySchema);
    const admin = createAdminClient();
    const fullName = body.fullName ?? body.email.split("@")[0];

    const { data: created, error: createError } =
      await admin.auth.admin.createUser({
        email: body.email,
        password: body.password,
        email_confirm: true,
        user_metadata: {
          full_name: fullName,
          role: "operator",
        },
      });

    if (createError || !created.user) {
      // User may already exist from a previous unconfirmed signup — confirm + set password
      const existing = await findUserByEmail(admin, body.email);
      if (!existing) {
        throw new AuthorizationError(
          createError?.message ?? "Registration failed",
          { statusHint: 400 },
        );
      }

      const { error: updateError } = await admin.auth.admin.updateUserById(
        existing.id,
        {
          password: body.password,
          email_confirm: true,
          user_metadata: {
            full_name: fullName,
            role: existing.user_metadata?.role ?? "operator",
          },
        },
      );
      if (updateError) {
        throw new AuthorizationError(updateError.message, { statusHint: 400 });
      }

      await ensureProfile(admin, existing.id, body.email, fullName, true);
      const sessionUser = await signInSession(body.email, body.password);
      return jsonOk({
        user: sessionUser,
        recoveredExisting: true,
        message: "Existing account recovered and signed in.",
      });
    }

    await ensureProfile(admin, created.user.id, body.email, fullName, true);
    const sessionUser = await signInSession(body.email, body.password);

    return jsonOk({
      user: sessionUser,
      needsEmailConfirmation: false,
      message: "Account created. You are signed in.",
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

async function ensureProfile(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  email: string,
  fullName: string,
  preferAdminIfFirst = false,
) {
  const { count: adminCount } = await admin
    .from("profiles")
    .select("id", { count: "exact", head: true })
    .eq("role", "admin");
  const role =
    preferAdminIfFirst && (adminCount ?? 0) === 0 ? "admin" : "operator";

  await admin.from("profiles").upsert({
    id: userId,
    email,
    full_name: fullName,
    role,
    is_active: true,
  });
}

async function signInSession(email: string, password: string) {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  if (error || !data.user) {
    throw new AuthorizationError(
      error?.message ??
        "Account created but automatic sign-in failed. Try signing in manually.",
      { statusHint: 401 },
    );
  }

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("*")
    .eq("id", data.user.id)
    .single();

  return {
    id: data.user.id,
    email: data.user.email ?? email,
    profile,
  };
}
