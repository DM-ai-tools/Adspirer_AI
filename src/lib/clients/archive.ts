import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { mapClientRow } from "@/lib/clients/map-client";
import { nowIso } from "@/lib/utils";
import type { Client } from "@/types";

/**
 * Archiving hides a client without deleting anything. A missing `archived_at`
 * counts as active, so the code is safe to deploy before the migration runs.
 */
export function isArchived(client: { archived_at?: string | null }): boolean {
  return Boolean(client.archived_at);
}

export function activeOnly<T extends { archived_at?: string | null }>(clients: T[]): T[] {
  return clients.filter((c) => !isArchived(c));
}

export function archivedOnly<T extends { archived_at?: string | null }>(clients: T[]): T[] {
  return clients.filter(isArchived);
}

const MIGRATION_HINT =
  "Archiving needs the database migration 00015_client_archive.sql (adds clients.archived_at). Run it on your Supabase database, then try again.";

/** Archive (true) or restore (false) a client. */
export async function setClientArchived(clientId: string, archived: boolean): Promise<Client> {
  const config = getConfig();
  const archivedAt = archived ? nowIso() : null;

  if (config.isDemoMode || !config.hasSupabase) {
    const store = getDemoStore();
    const idx = store.clients.findIndex((c) => c.id === clientId);
    if (idx < 0) throw new Error(`Client not found: ${clientId}`);
    store.clients[idx] = { ...store.clients[idx]!, archived_at: archivedAt, updated_at: nowIso() };
    return store.clients[idx]!;
  }

  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { data, error } = await createAdminClient()
    .from("clients")
    .update({ archived_at: archivedAt, updated_at: nowIso() })
    .eq("id", clientId)
    .select("*")
    .maybeSingle();
  if (error) {
    throw new Error(/archived_at/i.test(error.message) ? MIGRATION_HINT : error.message);
  }
  if (!data) throw new Error(`Client not found: ${clientId}`);
  return mapClientRow(data as Record<string, unknown>);
}

/** Ids of archived clients; empty when the migration has not been run yet. */
export async function getArchivedClientIds(): Promise<Set<string>> {
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    return new Set(getDemoStore().clients.filter(isArchived).map((c) => c.id));
  }
  try {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const { data, error } = await createAdminClient()
      .from("clients")
      .select("id")
      .not("archived_at", "is", null);
    if (error) return new Set();
    return new Set((data ?? []).map((r) => String(r.id)));
  } catch {
    return new Set();
  }
}
