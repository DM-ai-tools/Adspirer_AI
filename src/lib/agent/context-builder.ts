import type {
  Client,
  ClientService,
  CompetitorBrief,
  ConnectedMetaAccount,
  WorkspaceDocument,
} from "@/types";
import type { CreativeDraft } from "@/lib/creatives/drafts";
import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { getSelectedCreativeDraftAsync,
  listCreativeDraftsAsync,
  resolveImageUrlForAdspirer,
} from "@/lib/creatives/drafts";
import {
  formatDocumentsForContext,
  loadDocumentsForContext,
} from "@/lib/documents/service";
import { humanToolLabel } from "@/lib/tools/display-labels";
import { describeGoalsForAgent } from "@/lib/clients/goals";
import { mapClientRow } from "@/lib/clients/map-client";
import { clientGoogleAssets } from "@/lib/google/assets";
import { describeAgo, isStale } from "@/lib/shopify/query";
import { SHOPIFY_STALE_HOURS } from "@/lib/shopify/types";
import { buildClientBrandBlock } from "./prompts";

/** Reads the turn already started, shared so they are not repeated. */
export type PreloadedTurnReads = {
  metaAccounts?: Promise<ConnectedMetaAccount[]>;
  documents?: Promise<WorkspaceDocument[]>;
  selectedCreative?: Promise<CreativeDraft | null>;
};

type MappedGoogleAssets = Awaited<ReturnType<typeof clientGoogleAssets>>;

/** The client's mapped Google assets; null when they can't be read (the section then says so). */
async function loadGoogleAssets(clientId: string): Promise<MappedGoogleAssets | null> {
  try {
    return await clientGoogleAssets(clientId);
  } catch {
    return null;
  }
}

/**
 * What the read tools can reach for this client, so the model knows which
 * sources it can call (and what to tell the operator to map otherwise).
 */
export type ShopifyContextInfo = {
  name: string | null;
  domain: string;
  lastSyncAt: string | null;
  /** Fixed text from the sync when the latest sync failed; null otherwise. */
  lastSyncError?: string | null;
};

/**
 * Only name, domain, sync time and (when the latest sync failed) the sync's fixed error
 * text: nothing else from the connection reaches the model.
 */
async function loadShopifyInfo(clientId: string): Promise<ShopifyContextInfo | null> {
  try {
    const { getConnection } = await import("@/lib/shopify/store");
    const conn = await getConnection(clientId);
    return conn
      ? {
          name: conn.shop_name,
          domain: conn.shop_domain,
          lastSyncAt: conn.last_sync_at,
          lastSyncError: conn.last_sync_status === "error" ? (conn.last_sync_error ?? "no reason recorded") : null,
        }
      : null;
  } catch {
    return null;
  }
}

/**
 * One line: the catalogue (products, SKUs, stock, price, cost) is read live; only sales
 * are synced, so only they carry an age, a stale flag or a failed-sync note.
 */
function describeShopify(shopify: ShopifyContextInfo | null | undefined, now: Date): string {
  if (!shopify) return "- Shopify: not connected (an admin can connect it under Admin → Connections)";
  const head = `- Shopify: ${shopify.name ?? shopify.domain} (${shopify.domain}), catalogue read live`;
  const ago = shopify.lastSyncAt ? describeAgo(shopify.lastSyncAt, now) : null;
  if (shopify.lastSyncError) {
    const failed = `latest sales sync failed (${shopify.lastSyncError})`;
    return ago
      ? `${head}, ${failed}; sales are from the last successful sync ${ago}`
      : `${head}, ${failed}; sales not synced yet`;
  }
  if (!shopify.lastSyncAt || !ago) return `${head}, sales not synced yet`;
  const stale = isStale(shopify.lastSyncAt, now) ? ` (stale: older than ${SHOPIFY_STALE_HOURS} hours)` : "";
  return `${head}, sales synced ${ago}${stale}`;
}

export function describeConnectedData(
  meta: ConnectedMetaAccount[],
  google: MappedGoogleAssets | null,
  shopify?: ShopifyContextInfo | null,
  now: Date = new Date(),
): string[] {
  const primary = meta.find((m) => m.access_status === "granted");
  const line = (label: string, asset: { name: string } | null | undefined, what: string) =>
    asset
      ? `- ${label}: ${asset.name} (mapped; read-only)`
      : `- ${label}: not mapped (map a ${what} under Admin → Connections to read it)`;
  return [
    "## Connected data (read with the data tools; ids are resolved for you)",
    primary
      ? `- Meta: ${primary.meta_account_name} (${primary.meta_account_id})`
      : "- Meta: not mapped (map the Meta ad account under Admin → Connections)",
    ...(google
      ? [
          line("GA4", google.ga4, "GA4 property"),
          line("Search Console", google.gsc, "Search Console site"),
          line("Google Ads", google.ads, "Google Ads account"),
        ]
      : ["- Google (GA4 / Search Console / Google Ads): the mapping couldn't be read this turn"]),
    describeShopify(shopify, now),
  ];
}

export async function buildClientContext(
  clientId: string,
  options?: { conversationId?: string | null; preloaded?: PreloadedTurnReads },
): Promise<string> {
  const conversationId = options?.conversationId ?? null;
  const preloaded = options?.preloaded;
  // Started first so it loads alongside the reads below.
  const googlePromise = loadGoogleAssets(clientId);
  const shopifyPromise = loadShopifyInfo(clientId);
  // Independent reads — run them together rather than one round trip at a time.
  const [
    client,
    services,
    briefs,
    meta,
    documents,
    selectedCreative,
    drafts,
  ] = await Promise.all([
    loadClient(clientId),
    loadServices(clientId),
    loadBriefs(clientId),
    preloaded?.metaAccounts ?? loadMappedMetaAccounts(clientId),
    (
      preloaded?.documents ??
      loadDocumentsForContext({ clientId, conversationId })
    ).catch(() => [] as WorkspaceDocument[]),
    (
      preloaded?.selectedCreative ??
      getSelectedCreativeDraftAsync(clientId, { conversationId })
    ).catch(() => null),
    listCreativeDraftsAsync(clientId, {
      conversationId: conversationId ?? undefined,
    }).catch(() => []),
  ]);
  const google = await googlePromise;
  const shopify = await shopifyPromise;
  if (!client) {
    return `Client id ${clientId} not found.`;
  }
  const recentDrafts = drafts.slice(0, 3);
  const recentApprovals = loadRecentApprovals(clientId);

  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  const sections = [
    "## Today",
    `- Today is ${today.toISOString().slice(0, 10)} (UTC); the latest whole day is ${yesterday.toISOString().slice(0, 10)}. "Last N days" means the N whole days ending ${yesterday.toISOString().slice(0, 10)}.`,
    "",
    "## Meta connection",
    [
      "- Access: the operator's Facebook login → Meta Graph API",
      meta.length
        ? [
            `- Mapped Meta accounts for this client: ${meta.length}`,
            ...meta.map(
              (m) =>
                `  · ${m.meta_account_name} (${m.meta_account_id}) · access=${m.access_status}`,
            ),
            `- Primary account for API calls: ${
              meta.find((m) => m.access_status === "granted")
                ?.meta_account_name ?? "(none granted)"
            }`,
          ].join("\n")
        : "- No Meta account mapped yet — Connect Facebook + map under Connections",
    ].join("\n"),
    "",
    ...describeConnectedData(meta, google, shopify),
    "",
    "## Brand context",
    buildClientBrandBlock(client),
    client.brand_guidelines
      ? `Guidelines: ${client.brand_guidelines}`
      : null,
    client.website_url
      ? `Website: ${client.website_url} (brand reference only — never assume it is this campaign's landing page; ask which URL this campaign points to)`
      : null,
    "",
    "## Goals & guardrails",
    describeGoalsForAgent(client.goals_profile ?? {}, client.currency).join("\n"),
    "",
    ...(client.standing_instructions
      ? [
          "## Standing instructions",
          "Follow these on every turn unless the operator overrides them in this conversation.",
          client.standing_instructions,
          "",
        ]
      : []),
    "## Services",
    services.length
      ? services
          .map(
            (s) =>
              `- ${s.name}${s.description ? `: ${s.description}` : ""}${
                s.keywords?.length ? ` (keywords: ${s.keywords.join(", ")})` : ""
              }`,
          )
          .join("\n")
      : "- (none)",
    "",
    "## Connected Meta accounts",
    meta.length
      ? meta
          .map(
            (m) =>
              `- ${m.meta_account_name} (${m.meta_account_id}) · access=${m.access_status}`,
          )
          .join("\n")
      : "- (none)",
    "",
    "## Competitor brief highlights",
    briefs.length
      ? briefs
          .map(
            (b) =>
              `- ${b.summary ?? "Brief"}${
                b.opportunities?.length
                  ? ` · Opportunities: ${b.opportunities.slice(0, 2).join("; ")}`
                  : ""
              }`,
          )
          .join("\n")
      : "- (none)",
    "",
    "## Workspace documents",
    "Operator-uploaded PDF / Word / Markdown (competitors, frameworks, briefs). Use these when summarizing or generating ads/creatives.",
    formatDocumentsForContext(documents),
    "",
    "## Creative workflow (this conversation only)",
    selectedCreative
      ? `- Selected creative: ${selectedCreative.headline} · image=${resolveImageUrlForAdspirer(selectedCreative) ?? "pending"}`
      : "- (no creative selected in this conversation — do not reuse one from another campaign, and do not start generating until the operator asks)",
    recentDrafts.length
      ? recentDrafts
          .map(
            (d) =>
              `- ${d.headline} · status=${d.status} · image=${d.image_status}`,
          )
          .join("\n")
      : "- (no recent drafts)",
    "",
    "## Recent approval decisions",
    recentApprovals.length
      ? recentApprovals
          .map((a) => `- ${humanToolLabel(a.tool_name)} · ${a.status}${a.execution_error ? ` · error=${a.execution_error}` : ""}`)
          .join("\n")
      : "- (none)",
  ];

  return sections.filter((line) => line !== null).join("\n");
}

async function loadClient(clientId: string): Promise<Client | null> {
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    return getDemoStore().clients.find((c) => c.id === clientId) ?? null;
  }
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("clients")
    .select("*")
    .eq("id", clientId)
    .maybeSingle();
  // Map the row: it stores the budget ceiling in dollars and goals as raw JSON.
  return data ? mapClientRow(data as Record<string, unknown>) : null;
}

async function loadServices(clientId: string): Promise<ClientService[]> {
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    return getDemoStore().clientServices.filter((s) => s.client_id === clientId);
  }
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("client_services")
    .select("*")
    .eq("client_id", clientId);
  return (data as ClientService[]) ?? [];
}

/** Every research run adds a brief; the chat context carries only the newest few. */
const CONTEXT_BRIEF_LIMIT = 5;

async function loadBriefs(clientId: string): Promise<CompetitorBrief[]> {
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    return getDemoStore()
      .competitorBriefs.filter((b) => b.client_id === clientId && b.status === "ready")
      .sort((a, b) => (b.generated_at ?? b.created_at).localeCompare(a.generated_at ?? a.created_at))
      .slice(0, CONTEXT_BRIEF_LIMIT);
  }
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("competitor_briefs")
    .select("*")
    .eq("client_id", clientId)
    .eq("status", "ready")
    .order("researched_at", { ascending: false, nullsFirst: false })
    .limit(CONTEXT_BRIEF_LIMIT);
  const { competitorBriefFromRow } = await import("@/lib/competitors/brief-row");
  return ((data ?? []) as Array<Record<string, unknown>>).map(competitorBriefFromRow);
}

import { loadMappedMetaAccounts } from "@/lib/adspirer/resolve-meta-account";

function loadRecentApprovals(clientId: string) {
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    return getDemoStore()
      .approvals.filter((a) => a.client_id === clientId)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, 5);
  }
  return [];
}
