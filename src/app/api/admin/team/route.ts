import { randomBytes } from "node:crypto";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertAdmin } from "@/lib/authz/assert";
import { USER_ROLES, type Profile } from "@/types";
import { nowIso } from "@/lib/utils";
import { jsonOk, parseBody, withApiHandler } from "@/lib/api/response";

const inviteSchema = z.object({
  email: z.string().email(),
  fullName: z.string().min(1).optional(),
  role: z.enum([USER_ROLES.ADMIN, USER_ROLES.OPERATOR]).default("operator"),
});

export async function GET() {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    assertAdmin(user);

    const config = getConfig();
    if (config.isDemoMode || !config.hasSupabase) {
      return jsonOk({ users: getDemoStore().profiles });
    }

    const { createAdminClient } = await import("@/lib/supabase/admin");
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("profiles")
      .select("*")
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    return jsonOk({ users: (data ?? []) as Profile[] });
  });
}

export async function POST(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    assertAdmin(user);

    const body = await parseBody(request, inviteSchema);
    const email = body.email.toLowerCase();
    const fullName = body.fullName ?? email.split("@")[0];
    const ts = nowIso();
    const config = getConfig();

    if (config.isDemoMode || !config.hasSupabase) {
      const store = getDemoStore();
      const existing = store.profiles.find(
        (p) => p.email.toLowerCase() === email,
      );
      if (existing) {
        throw new Error(`User already exists: ${email}`);
      }
      const profile: Profile = {
        id: `profile_${ts}`,
        email,
        full_name: fullName,
        role: body.role,
        avatar_url: null,
        is_active: true,
        created_at: ts,
        updated_at: ts,
      };
      store.profiles.push(profile);
      return jsonOk(
        {
          user: profile,
          invited: true,
          delivery: "demo",
          message: "Demo mode: user stored in memory only (no email sent).",
        },
        201,
      );
    }

    const { createAdminClient } = await import("@/lib/supabase/admin");
    const admin = createAdminClient();

    let authUserId: string | null = null;
    let delivery: "invite_email" | "created_no_email" = "invite_email";
    let message =
      "Invite email sent. They can set a password from the email link.";

    // Prefer real invite email when auth email delivery is configured.
    const invite = await admin.auth.admin.inviteUserByEmail(email, {
      data: { full_name: fullName, role: body.role },
      redirectTo: `${config.APP_URL}/login`,
    });

    if (!invite.error && invite.data.user) {
      authUserId = invite.data.user.id;
    } else {
      // Fallback when SMTP/invite isn't set up: create a confirmed user with a
      // temporary password the admin can share (or use password reset later).
      const tempPassword = `Tmp-${randomBytes(9).toString("base64url")}`;
      const created = await admin.auth.admin.createUser({
        email,
        password: tempPassword,
        email_confirm: true,
        user_metadata: { full_name: fullName, role: body.role },
      });
      if (created.error || !created.data.user) {
        throw new Error(
          invite.error?.message ??
            created.error?.message ??
            "Failed to invite user",
        );
      }
      authUserId = created.data.user.id;
      delivery = "created_no_email";
      message =
        "User created, but the invite email could not be sent. Ask them to register with the same email, or reset their password from Sign in.";
      // Temp password is intentionally not returned in API responses.
      void tempPassword;
    }

    const { data: profile, error: profileError } = await admin
      .from("profiles")
      .upsert(
        {
          id: authUserId,
          email,
          full_name: fullName,
          role: body.role,
          is_active: true,
        },
        { onConflict: "id" },
      )
      .select("*")
      .single();
    if (profileError) throw new Error(profileError.message);

    return jsonOk(
      {
        user: profile as Profile,
        invited: true,
        delivery,
        message,
      },
      201,
    );
  });
}
