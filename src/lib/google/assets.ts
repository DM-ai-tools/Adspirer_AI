import { randomUUID } from "node:crypto";
import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { NotFoundError } from "@/lib/errors";
import { createAdminClient } from "@/lib/supabase/admin";
import { nowIso } from "@/lib/utils";
import { discoverAdsAccounts } from "./ads";
import { listGa4Properties } from "./ga4";
import { listGscSites } from "./gsc";
import type { GoogleAsset, GoogleAssetKind } from "./types";

/**
 * The Google assets the agency connection can see, each optionally mapped to
 * one client (at most one asset of each kind per client). Sync only discovers
 * and records; it never writes to Google.
 */

const TABLE = "connected_google_assets";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What sync learns about one asset; mapping and timestamps are kept by the store. */
type DiscoveredAsset = Pick<
  GoogleAsset,
  "kind" | "external_id" | "name" | "parent_name" | "currency" | "timezone" | "login_customer_id" | "raw_metadata"
>;

function inDemoStore(): boolean {
  const config = getConfig();
  return config.isDemoMode || !config.hasSupabase;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function discoverGa4(): Promise<DiscoveredAsset[]> {
  return (await listGa4Properties()).map((p) => ({
    kind: "ga4_property",
    external_id: `properties/${p.propertyId}`,
    name: p.name || `properties/${p.propertyId}`,
    parent_name: p.accountName || null,
    currency: p.currency,
    timezone: p.timezone,
    login_customer_id: null,
    raw_metadata: { ...p },
  }));
}

async function discoverAds(): Promise<DiscoveredAsset[]> {
  return (await discoverAdsAccounts()).map((a) => ({
    kind: "ads_customer",
    external_id: a.customerId,
    name: a.name || a.customerId,
    parent_name: a.parentName,
    currency: a.currency || null,
    timezone: a.timezone || null,
    login_customer_id: a.loginCustomerId,
    raw_metadata: { ...a },
  }));
}

async function discoverGsc(): Promise<DiscoveredAsset[]> {
  return (await listGscSites())
    .filter((s) => s.permissionLevel !== "siteUnverifiedUser")
    .map((s) => ({
      kind: "gsc_site",
      external_id: s.siteUrl,
      name: s.siteUrl,
      parent_name: null,
      currency: null,
      timezone: null,
      login_customer_id: null,
      raw_metadata: { ...s },
    }));
}

/** Insert or update by (kind, external_id); an existing row keeps its id and mapping. */
async function upsertAssets(assets: DiscoveredAsset[]): Promise<void> {
  if (!assets.length) return;
  const now = nowIso();

  if (inDemoStore()) {
    const store = getDemoStore();
    for (const asset of assets) {
      const existing = store.googleAssets.find((a) => a.kind === asset.kind && a.external_id === asset.external_id);
      if (existing) {
        Object.assign(existing, asset, { last_synced_at: now, updated_at: now });
      } else {
        store.googleAssets.push({
          ...asset,
          id: randomUUID(),
          mapped_client_id: null,
          last_synced_at: now,
          created_at: now,
          updated_at: now,
        });
      }
    }
    return;
  }

  // mapped_client_id is not sent, so an update leaves the mapping alone.
  const { error } = await createAdminClient()
    .from(TABLE)
    .upsert(
      assets.map((asset) => ({ ...asset, last_synced_at: now })),
      { onConflict: "kind,external_id" },
    );
  if (error) throw new Error(error.message);
}

/**
 * Discovers the GA4 properties, Google Ads accounts and Search Console sites
 * the connection can see. Each part is independent: one failing becomes a
 * warning and the others still sync.
 */
export async function syncGoogleAssets(): Promise<{
  ga4: number;
  ads: number;
  gsc: number;
  warnings: string[];
}> {
  // DEMO_MODE never calls Google: the seeded demo assets are what there is to sync.
  if (getConfig().isDemoMode) {
    const count = (kind: GoogleAssetKind) => getDemoStore().googleAssets.filter((a) => a.kind === kind).length;
    return { ga4: count("ga4_property"), ads: count("ads_customer"), gsc: count("gsc_site"), warnings: [] };
  }
  const warnings: string[] = [];
  const part = async (label: string, discover: () => Promise<DiscoveredAsset[]>): Promise<number> => {
    try {
      const assets = await discover();
      await upsertAssets(assets);
      return assets.length;
    } catch (error) {
      warnings.push(`${label}: ${message(error)}`);
      return 0;
    }
  };

  const ga4 = await part("GA4", discoverGa4);
  const ads = await part("Google Ads", discoverAds);
  const gsc = await part("Search Console", discoverGsc);

  return { ga4, ads, gsc, warnings };
}

/** The asset as API responses show it: Google's raw discovery payload stays on the server. */
export function withoutRawMetadata(asset: GoogleAsset): Omit<GoogleAsset, "raw_metadata"> {
  const rest: Partial<GoogleAsset> = { ...asset };
  delete rest.raw_metadata;
  return rest as Omit<GoogleAsset, "raw_metadata">;
}

const KIND_ORDER: GoogleAssetKind[] = ["ga4_property", "ads_customer", "gsc_site"];

function sortAssets(assets: GoogleAsset[]): GoogleAsset[] {
  return [...assets].sort(
    (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.name.localeCompare(b.name),
  );
}

export async function listGoogleAssets(): Promise<GoogleAsset[]> {
  if (inDemoStore()) return sortAssets(getDemoStore().googleAssets);
  const { data, error } = await createAdminClient().from(TABLE).select("*");
  if (error) throw new Error(error.message);
  return sortAssets((data as GoogleAsset[] | null) ?? []);
}

/**
 * Maps an asset to a client, replacing any asset of the same kind already
 * mapped to it; `clientId: null` unmaps.
 */
export async function mapGoogleAsset(assetId: string, clientId: string | null): Promise<GoogleAsset> {
  const now = nowIso();

  if (inDemoStore()) {
    const store = getDemoStore();
    const asset = store.googleAssets.find((a) => a.id === assetId);
    if (!asset) throw new NotFoundError("Google asset not found");
    if (clientId !== null) {
      if (!store.clients.some((c) => c.id === clientId)) throw new NotFoundError("Client not found");
      for (const other of store.googleAssets) {
        if (other.id !== asset.id && other.kind === asset.kind && other.mapped_client_id === clientId) {
          other.mapped_client_id = null;
          other.updated_at = now;
        }
      }
    }
    asset.mapped_client_id = clientId;
    asset.updated_at = now;
    return asset;
  }

  // Row ids are uuids; anything else can't match and would make Postgres error.
  if (!UUID_RE.test(assetId)) throw new NotFoundError("Google asset not found");
  const supabase = createAdminClient();
  const found = await supabase.from(TABLE).select("*").eq("id", assetId).maybeSingle();
  if (found.error) throw new Error(found.error.message);
  const asset = found.data as GoogleAsset | null;
  if (!asset) throw new NotFoundError("Google asset not found");

  if (clientId !== null) {
    if (!UUID_RE.test(clientId)) throw new NotFoundError("Client not found");
    const client = await supabase.from("clients").select("id").eq("id", clientId).maybeSingle();
    if (client.error) throw new Error(client.error.message);
    if (!client.data) throw new NotFoundError("Client not found");
    // Unmap the client's current asset of this kind first: the one-per-client
    // unique index would reject the new mapping while the old one stands.
    const cleared = await supabase
      .from(TABLE)
      .update({ mapped_client_id: null })
      .eq("kind", asset.kind)
      .eq("mapped_client_id", clientId)
      .neq("id", assetId);
    if (cleared.error) throw new Error(cleared.error.message);
  }

  const updated = await supabase
    .from(TABLE)
    .update({ mapped_client_id: clientId })
    .eq("id", assetId)
    .select("*")
    .single();
  if (updated.error) throw new Error(updated.error.message);
  return updated.data as GoogleAsset;
}

/** The GA4 property, Google Ads account and Search Console site mapped to a client. */
export async function clientGoogleAssets(clientId: string): Promise<{
  ga4: GoogleAsset | null;
  ads: GoogleAsset | null;
  gsc: GoogleAsset | null;
}> {
  let assets: GoogleAsset[];
  if (inDemoStore()) {
    assets = getDemoStore().googleAssets.filter((a) => a.mapped_client_id === clientId);
  } else if (!UUID_RE.test(clientId)) {
    assets = [];
  } else {
    const { data, error } = await createAdminClient().from(TABLE).select("*").eq("mapped_client_id", clientId);
    if (error) throw new Error(error.message);
    assets = (data as GoogleAsset[] | null) ?? [];
  }
  const ofKind = (kind: GoogleAssetKind) => assets.find((a) => a.kind === kind) ?? null;
  return { ga4: ofKind("ga4_property"), ads: ofKind("ads_customer"), gsc: ofKind("gsc_site") };
}
