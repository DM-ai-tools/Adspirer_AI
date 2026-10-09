import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getConfig } from "@/lib/config";

export async function GET() {
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    // Demo mode runs on mock Meta data; there is no Facebook token to report.
    return NextResponse.json({ connected: false, demo: true });
  }
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ connected: false });
  }

  const { data } = await supabase
    .from("meta_oauth_tokens")
    .select("meta_user_name, meta_user_id, token_expires_at, scopes")
    .eq("user_id", user.id)
    .single();

  if (!data) {
    return NextResponse.json({ connected: false });
  }

  // An expired token is not a working connection — say so, so the UI can
  // prompt a reconnect instead of showing "Connected" while every call fails.
  const expired =
    data.token_expires_at != null &&
    Date.parse(data.token_expires_at) <= Date.now();

  return NextResponse.json({
    connected: !expired,
    expired,
    metaUserName: data.meta_user_name,
    metaUserId: data.meta_user_id,
    expiresAt: data.token_expires_at,
    scopes: data.scopes,
  });
}
