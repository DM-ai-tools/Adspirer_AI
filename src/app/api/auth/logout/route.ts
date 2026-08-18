import { cookies } from "next/headers";
import { getConfig } from "@/lib/config";
import { DEMO_USER_COOKIE } from "@/lib/security/auth";
import { jsonOk, withApiHandler } from "@/lib/api/response";

export async function POST() {
  return withApiHandler(async () => {
    const cookieStore = await cookies();
    cookieStore.delete(DEMO_USER_COOKIE);

    const config = getConfig();
    if (!config.isDemoMode && config.hasSupabase) {
      const { createClient } = await import("@/lib/supabase/server");
      const supabase = await createClient();
      await supabase.auth.signOut();
    }

    return jsonOk({ loggedOut: true });
  });
}
