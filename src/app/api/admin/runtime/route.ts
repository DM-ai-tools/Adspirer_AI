import { getConfig } from "@/lib/config";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertAdmin } from "@/lib/authz/assert";
import { jsonOk, withApiHandler } from "@/lib/api/response";
import type { AdsExecutionMode } from "@/types";

export type RuntimeSettings = {
  demoMode: boolean;
  /** Why demo mode is on: set explicitly, or Supabase isn't configured so the app fell back to it. */
  demoReason: "env" | "no_supabase" | null;
  adsExecutionMode: AdsExecutionMode;
  approvalExpiryHours: number;
  accessStaleDays: number;
  budgetCeilingCents: number;
};

/** The values this deployment is actually running with, for the admin Settings page. */
export async function GET() {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    assertAdmin(user);

    const config = getConfig();
    const settings: RuntimeSettings = {
      demoMode: config.isDemoMode,
      demoReason: !config.isDemoMode ? null : !config.hasSupabase ? "no_supabase" : "env",
      adsExecutionMode: config.adsExecutionMode,
      approvalExpiryHours: config.APPROVAL_EXPIRY_HOURS,
      accessStaleDays: config.ACCESS_REQUEST_STALE_DAYS,
      budgetCeilingCents: config.BUDGET_CEILING_DEFAULT_CENTS,
    };
    return jsonOk(settings);
  });
}
