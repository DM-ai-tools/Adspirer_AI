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
  /** Invite and password-reset emails go out through Resend (RESEND_API_KEY and EMAIL_FROM both set). */
  emailConfigured: boolean;
  /** The address they are sent from, when set. */
  emailFrom: string | null;
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
      emailConfigured: Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM),
      emailFrom: process.env.EMAIL_FROM?.trim() || null,
      approvalExpiryHours: config.APPROVAL_EXPIRY_HOURS,
      accessStaleDays: config.ACCESS_REQUEST_STALE_DAYS,
      budgetCeilingCents: config.BUDGET_CEILING_DEFAULT_CENTS,
    };
    return jsonOk(settings);
  });
}
