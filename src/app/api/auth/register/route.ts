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
    assertSignupDomainAllowed(body.email, config.SIGNUP_ALLOWED_DOMAINS);
    const admin = createAdminClient();
    const fullName = body.fullName ?? body.email.split("@")[0];

    const { data: created, error: createError } =
      await admin.auth.admin.createUser({
        email: body.email,
        password: body.password,
        email_confirm: true,
        user_metadata: {
          full_name: fullName,
        },
      });

    if (createError || !created.user) {
      // Never touch an existing account from this unauthenticated endpoint —
      // resetting its password here would let anyone take over any email.
      const alreadyExists =
        createError?.status === 422 ||
        /already (been )?registered|already exists/i.test(
          createError?.message ?? "",
        );
      throw new AuthorizationError(
        alreadyExists
          ? "An account with this email already exists. Sign in instead, or ask your administrator to reset your password."
          : "Registration failed. Please try again.",
        { statusHint: alreadyExists ? 409 : 400 },
      );
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

  // Only fills in a profile for a brand-new user; never overwrites an
  // existing row (and therefore never changes an existing user's role).
  await admin.from("profiles").upsert(
    {
      id: userId,
      email,
      full_name: fullName,
      role,
      is_active: true,
    },
    { onConflict: "id", ignoreDuplicates: true },
  );
  if (role === "admin") {
    // The signup trigger may have inserted the row first as an operator.
    await admin.from("profiles").update({ role }).eq("id", userId);
  }
}

function assertSignupDomainAllowed(email: string, allowedDomains?: string) {
  const domains = (allowedDomains ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
  if (!domains.length) return;
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  if (!domains.includes(domain)) {
    throw new AuthorizationError(
      "Self-registration is limited to your organisation's email domain. Ask an administrator to invite you.",
      { statusHint: 403 },
    );
  }
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
