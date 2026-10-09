import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { invalidateUserMetaToken } from "@/lib/meta/get-user-token";

export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { error } = await supabase
    .from("meta_oauth_tokens")
    .delete()
    .eq("user_id", user.id);
  invalidateUserMetaToken(user.id);
  if (error) {
    return NextResponse.json(
      { error: "Could not disconnect Facebook. Please try again." },
      { status: 500 },
    );
  }

  return NextResponse.json({ disconnected: true });
}
