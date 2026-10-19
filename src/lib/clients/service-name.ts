import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { ConflictError } from "@/lib/errors";

const norm = (name: string) => name.trim().toLowerCase();

/**
 * One service/category name per client, ignoring case. `exceptId` skips the
 * row being renamed.
 */
export async function assertUniqueServiceName(
  clientId: string,
  name: string,
  exceptId?: string,
): Promise<void> {
  const config = getConfig();
  let names: Array<{ id: string; name: string }>;

  if (config.isDemoMode || !config.hasSupabase) {
    names = getDemoStore().clientServices.filter((s) => s.client_id === clientId);
  } else {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const { data, error } = await createAdminClient()
      .from("client_services")
      .select("id, name")
      .eq("client_id", clientId);
    if (error) throw new Error(error.message);
    names = (data ?? []) as Array<{ id: string; name: string }>;
  }

  if (names.some((s) => s.id !== exceptId && norm(s.name) === norm(name))) {
    throw new ConflictError("A category or service with this name already exists", { name });
  }
}
