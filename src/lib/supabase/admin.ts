import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getConfig } from "@/lib/config";

const DEMO_URL = "http://localhost:54321";
const DEMO_SERVICE_KEY = "demo-service-role-key";

/**
 * Service-role Supabase client. Server-only — never import from client components.
 */
export function createAdminClient(): SupabaseClient {
  const config = getConfig();
  const url = config.NEXT_PUBLIC_SUPABASE_URL ?? DEMO_URL;
  const serviceKey = config.SUPABASE_SERVICE_ROLE_KEY ?? DEMO_SERVICE_KEY;

  if (!config.hasSupabase && !config.isDemoMode) {
    throw new Error(
      "Supabase service role client requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY",
    );
  }

  return createSupabaseClient(url, serviceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
