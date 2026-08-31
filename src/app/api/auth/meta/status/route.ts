import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET() {
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

  return NextResponse.json({
    connected: true,
    metaUserName: data.meta_user_name,
    metaUserId: data.meta_user_id,
    expiresAt: data.token_expires_at,
    scopes: data.scopes,
  });
}
