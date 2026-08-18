import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getConfig } from "@/lib/config";

const DEMO_URL = "http://localhost:54321";
const DEMO_ANON_KEY = "demo-anon-key";

/**
 * Server Supabase client with cookie-based session.
 * Next.js 16: `cookies()` is async.
 */
export async function createClient(): Promise<SupabaseClient> {
  const config = getConfig();
  const cookieStore = await cookies();
  const url = config.NEXT_PUBLIC_SUPABASE_URL ?? DEMO_URL;
  const anonKey = config.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? DEMO_ANON_KEY;

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component — middleware will refresh sessions.
        }
      },
    },
  });
}
