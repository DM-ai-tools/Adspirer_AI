import type { Profile } from "@/types";
import {
  AuthorizationError,
  ClientAccessError,
} from "@/lib/errors";
import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { isAdmin } from "@/lib/security/roles";
import type { AuthUser } from "@/lib/security/auth";

export function assertAuthenticated(
  user: AuthUser | null | undefined,
): asserts user is AuthUser {
  if (!user) {
    throw new AuthorizationError("Authentication required", { statusHint: 401 });
  }
}

export function assertAdmin(
  user: AuthUser | Pick<Profile, "role"> | null | undefined,
): void {
  const profile = user && "profile" in user ? user.profile : user;
  if (!isAdmin(profile as Profile | null)) {
    throw new AuthorizationError("Admin role required");
  }
}

/**
 * Ensure the user is assigned to the client (admins bypass).
 */
export async function assertClientAccess(
  userId: string,
  clientId: string,
): Promise<void> {
  const config = getConfig();

  if (config.isDemoMode || !config.hasSupabase) {
    const store = getDemoStore();
    const profile = store.profiles.find((p) => p.id === userId);
    if (profile && isAdmin(profile)) return;

    const access = store.userClientAccess.find(
      (a) => a.user_id === userId && a.client_id === clientId,
    );
    if (!access) {
      throw new ClientAccessError("No access to this client", {
        userId,
        clientId,
      });
    }
    return;
  }

  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .maybeSingle();

  if (profile && isAdmin(profile as Profile)) return;

  const { data: access } = await supabase
    .from("user_client_access")
    .select("id")
    .eq("user_id", userId)
    .eq("client_id", clientId)
    .maybeSingle();

  if (!access) {
    throw new ClientAccessError("No access to this client", {
      userId,
      clientId,
    });
  }
}
