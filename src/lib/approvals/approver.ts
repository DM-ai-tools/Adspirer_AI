import type { Approval, UserRole } from "@/types";
import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { AuthorizationError } from "@/lib/errors";

/** A profile's role, or null when the profile doesn't exist. */
export async function getUserRole(userId: string): Promise<UserRole | null> {
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    return getDemoStore().profiles.find((p) => p.id === userId)?.role ?? null;
  }
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { data, error } = await createAdminClient()
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data?.role as UserRole | undefined) ?? null;
}

/** High-risk changes are approved by admins only. */
export async function assertMayApprove(
  approval: Pick<Approval, "risk_level" | "risk_reason">,
  reviewerId: string | null,
): Promise<void> {
  if (approval.risk_level !== "high" && approval.risk_level !== "critical") return;
  const role = reviewerId ? await getUserRole(reviewerId) : null;
  if (role !== "admin") {
    throw new AuthorizationError(
      `This is a high-risk change${approval.risk_reason ? ` (${approval.risk_reason.replace(/\.$/, "")})` : ""}. An admin must approve it.`,
    );
  }
}
