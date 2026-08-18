import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getConfig } from "@/lib/config";

const DEMO_URL = "http://localhost:54321";
const DEMO_ANON_KEY = "demo-anon-key";

/**
 * Browser Supabase client. In DEMO_MODE (or missing env), returns a client
 * pointed at placeholder credentials — callers should prefer demo store paths.
 */
export function createClient(): SupabaseClient {
  const config = getConfig();
  const url = config.NEXT_PUBLIC_SUPABASE_URL ?? DEMO_URL;
  const anonKey = config.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? DEMO_ANON_KEY;

  return createBrowserClient(url, anonKey);
}
