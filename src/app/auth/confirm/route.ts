import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { createClient } from "@/lib/supabase/server";
import { appBaseUrl, safeNextPath } from "@/lib/team/members";

const TYPES = new Set<EmailOtpType>(["invite", "magiclink", "recovery", "email", "signup"]);

/**
 * Landing point for invite, sign-in and password-reset links: verifies the
 * one-time token, which starts a session (cookies), then continues to
 * /welcome to choose a password.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const base = appBaseUrl(request);
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;
  const next = safeNextPath(url.searchParams.get("next"));
  const config = getConfig();

  const fail = (reason: string) => NextResponse.redirect(`${base}/login?error=${encodeURIComponent(reason)}`);
  if (config.isDemoMode || !config.hasSupabase) return fail("Invite links work only on the live app.");
  if (!tokenHash || !type || !TYPES.has(type)) return fail("That link is incomplete. Ask your admin to send a new one.");

  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
  if (error) return fail("That link has expired or was already used. Ask your admin to send a new one.");
  const reset = type === "recovery" ? `${next.includes("?") ? "&" : "?"}reset=1` : "";
  return NextResponse.redirect(`${base}${next}${reset}`);
}
