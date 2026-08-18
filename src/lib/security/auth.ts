import { cookies } from "next/headers";
import type { Profile } from "@/types";
import { getConfig } from "@/lib/config";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getDemoStore } from "@/lib/demo/store";
import { logger } from "@/lib/observability/logger";

const DEMO_USER_COOKIE = "adspirer_demo_user";

export type AuthUser = {
  id: string;
  email: string;
  profile: Profile;
};

/**
 * Resolve the current authenticated user + profile.
 * Live mode: Supabase Auth session + profiles row (auto-healed via service role).
 */
export async function getCurrentUser(): Promise<AuthUser | null> {
  const config = getConfig();

  if (config.isDemoMode || !config.hasSupabase) {
    return getDemoUser();
  }

  try {
    const supabase = await createClient();
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser();

    if (error || !user) {
      if (error) {
        logger.warn("Supabase getUser failed", { message: error.message });
      }
      return null;
    }

    const profile = await ensureProfileForUser(user.id, user.email, user.user_metadata);
    if (!profile) return null;

    return {
      id: user.id,
      email: user.email ?? profile.email,
      profile,
    };
  } catch (error) {
    // Schema / bootstrap failures should surface to the API, not look like logout.
    if (
      error instanceof Error &&
      /schema is incomplete|public\.profiles is missing|schema cache/i.test(
        error.message,
      )
    ) {
      throw error;
    }
    logger.error("getCurrentUser threw", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function ensureProfileForUser(
  userId: string,
  email: string | undefined,
  metadata: Record<string, unknown> | undefined,
): Promise<Profile | null> {
  const admin = createAdminClient();

  const { data: existing, error: selectError } = await admin
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .maybeSingle();

  if (selectError) {
    logger.error("Failed to load profile", {
      userId,
      message: selectError.message,
    });
    // Surface missing-migration clearly instead of a vague 401.
    if (/schema cache|does not exist|could not find the table/i.test(selectError.message)) {
      throw new Error(
        "Database schema is incomplete: public.profiles is missing. Run supabase/migrations/00001_foundation.sql in the Supabase SQL editor, then sign in again.",
      );
    }
  }

  if (existing) {
    // Heal bootstrap: if no admin exists yet, promote this user.
    if ((existing as Profile).role !== "admin") {
      const promoted = await promoteIfNoAdmin(admin, userId);
      if (promoted) return promoted;
    }
    return existing as Profile;
  }

  const fullName =
    (typeof metadata?.full_name === "string" && metadata.full_name) ||
    (typeof metadata?.name === "string" && metadata.name) ||
    (email ? email.split("@")[0] : "User");

  const role = (await countAdmins(admin)) === 0 ? "admin" : "operator";

  const { data: upserted, error: upsertError } = await admin
    .from("profiles")
    .upsert({
      id: userId,
      email: email ?? `${userId}@users.local`,
      full_name: fullName,
      role,
      is_active: true,
    })
    .select("*")
    .single();

  if (upsertError) {
    logger.error("Failed to create profile", {
      userId,
      message: upsertError.message,
    });
    if (/schema cache|does not exist|could not find the table/i.test(upsertError.message)) {
      throw new Error(
        "Database schema is incomplete: public.profiles is missing. Run supabase/migrations/00001_foundation.sql in the Supabase SQL editor, then sign in again.",
      );
    }
    return null;
  }

  return upserted as Profile;
}

async function countAdmins(
  admin: ReturnType<typeof createAdminClient>,
): Promise<number> {
  const { count } = await admin
    .from("profiles")
    .select("id", { count: "exact", head: true })
    .eq("role", "admin");
  return count ?? 0;
}

async function promoteIfNoAdmin(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
): Promise<Profile | null> {
  if ((await countAdmins(admin)) > 0) return null;

  const { data, error } = await admin
    .from("profiles")
    .update({ role: "admin" })
    .eq("id", userId)
    .select("*")
    .single();

  if (error) {
    logger.warn("Failed to promote bootstrap admin", {
      userId,
      message: error.message,
    });
    return null;
  }

  logger.info("Promoted first active user to admin", { userId });
  return data as Profile;
}

export async function requireCurrentUser(): Promise<AuthUser> {
  const user = await getCurrentUser();
  if (!user) {
    throw new Error("Authentication required");
  }
  return user;
}

export async function getCurrentProfile(): Promise<Profile | null> {
  const user = await getCurrentUser();
  return user?.profile ?? null;
}

async function getDemoUser(): Promise<AuthUser> {
  const store = getDemoStore();
  const cookieStore = await cookies();
  const preferred =
    cookieStore.get(DEMO_USER_COOKIE)?.value ?? "admin@adspirer.ai";

  const profile =
    store.profiles.find((p) => p.email === preferred) ??
    store.profiles.find((p) => p.email === "admin@adspirer.ai")!;

  return {
    id: profile.id,
    email: profile.email,
    profile,
  };
}

export { DEMO_USER_COOKIE };
