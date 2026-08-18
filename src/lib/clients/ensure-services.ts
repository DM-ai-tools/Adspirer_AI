import type { Client, ClientService } from "@/types";
import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { nowIso } from "@/lib/utils";

/**
 * Ensure a client has at least one service row so Competitors / Creatives
 * can run without a separate setup step.
 */
export async function ensureClientServices(
  clientId: string,
): Promise<ClientService[]> {
  const config = getConfig();

  if (config.isDemoMode || !config.hasSupabase) {
    const store = getDemoStore();
    const services = store.clientServices.filter((s) => s.client_id === clientId);
    if (services.length) return services;

    const client = store.clients.find((c) => c.id === clientId);
    const seeded = buildDefaultService(clientId, client);
    store.clientServices.push(seeded);
    return [seeded];
  }

  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();
  const { data: existing, error } = await supabase
    .from("client_services")
    .select("*")
    .eq("client_id", clientId);
  if (error) throw new Error(error.message);
  if (existing?.length) return existing as ClientService[];

  const { data: client } = await supabase
    .from("clients")
    .select("*")
    .eq("id", clientId)
    .maybeSingle();

  const seeded = buildDefaultService(clientId, (client as Client | null) ?? null);
  // Let Postgres generate the uuid; omit client-side id
  const { id: _id, ...insertRow } = seeded;
  const { data, error: insertError } = await supabase
    .from("client_services")
    .insert(insertRow)
    .select("*")
    .single();
  if (insertError) throw new Error(insertError.message);
  return [data as ClientService];
}

function buildDefaultService(
  clientId: string,
  client: Client | null | undefined,
): ClientService {
  const ts = nowIso();
  const name =
    client?.value_proposition?.split(/[.!]/)[0]?.trim().slice(0, 60) ||
    "Brand / General";
  return {
    id: crypto.randomUUID(),
    client_id: clientId,
    name,
    description:
      client?.value_proposition ??
      "Default service for competitor research and creative generation",
    keywords: client?.industry ? [client.industry] : null,
    landing_page_url: null,
    priority: 0,
    is_active: true,
    created_at: ts,
    updated_at: ts,
  };
}
