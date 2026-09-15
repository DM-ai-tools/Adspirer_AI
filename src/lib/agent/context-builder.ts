import type { Client, ClientService, CompetitorBrief } from "@/types";
import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { getSelectedCreativeDraftAsync,
  listCreativeDraftsAsync,
  resolveImageUrlForAdspirer,
} from "@/lib/creatives/drafts";
import { getWorkspaceContext } from "@/lib/runtime/workspace-context";
import {
  formatDocumentsForContext,
  loadDocumentsForContext,
} from "@/lib/documents/service";
import { humanToolLabel } from "@/lib/tools/display-labels";
import { buildClientBrandBlock } from "./prompts";

export async function buildClientContext(
  clientId: string,
  options?: { conversationId?: string | null },
): Promise<string> {
  const client = await loadClient(clientId);
  if (!client) {
    return `Client id ${clientId} not found.`;
  }

  const conversationId = options?.conversationId ?? null;
  const services = await loadServices(clientId);
  const briefs = await loadBriefs(clientId);
  const meta = await loadMappedMetaAccounts(clientId);
  const documents = await loadDocumentsForContext({
    clientId,
    conversationId,
  }).catch(() => []);
  const selectedCreative = await getSelectedCreativeDraftAsync(clientId, {
    conversationId,
  }).catch(() => null);
  const recentDrafts = (
    await listCreativeDraftsAsync(clientId, {
      conversationId: conversationId ?? undefined,
    }).catch(() => [])
  ).slice(0, 3);
  const recentApprovals = loadRecentApprovals(clientId);
  const isV2 = getWorkspaceContext()?.version === "v2";

  const sections = [
    "## Workspace mode",
    isV2
      ? [
          "- Version: Workspace V2 (Meta-direct)",
          "- Backend: Facebook OAuth → Meta Graph API (NOT Adspirer MCP)",
          "- If asked about Adspirer: say V2 does not use Adspirer; V1 does.",
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
        ].join("\n")
      : [
          "- Version: Workspace V1 (Adspirer)",
          "- Backend: Adspirer MCP / API when configured",
        ].join("\n"),
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
  return (data as Client | null) ?? null;
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

async function loadBriefs(clientId: string): Promise<CompetitorBrief[]> {
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    return getDemoStore().competitorBriefs.filter(
      (b) => b.client_id === clientId && b.status === "ready",
    );
  }
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("competitor_briefs")
    .select("*")
    .eq("client_id", clientId)
    .eq("status", "ready");
  return (data as CompetitorBrief[]) ?? [];
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
