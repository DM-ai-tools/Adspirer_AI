/**
 * Bridge diagnose-class registry tools into AI SDK tool() defs so the writer
 * LLM can choose which reads to run (no fixed sequence): Meta, landing pages,
 * GA4, Search Console, Google Ads and the client's categories.
 */
import "@/lib/tools/diagnose";
import { tool } from "ai";
import type { ToolSet } from "ai";
import type { RequestIntent } from "@/lib/agent/task-plan";
import { classify } from "@/lib/tools/policy";
import { getTool, invokeTool, type ToolContext } from "@/lib/tools/registry";

/**
 * Read-only tools the writer may call. Execute tools stay Approvals-only, and
 * nothing here can write to Meta or Google.
 */
const WORKSPACE_READ_ALLOWLIST = [
  "get_account_overview",
  "list_campaigns",
  "list_adsets",
  "list_ads",
  "get_campaign_insights",
  "get_account_insights",
  "get_meta_ad_creatives",
  "analyze_landing_pages",
  "analyze_account",
  "analyze_brand_url",
  "generate_ad_images",
  "meta_insights",
  // Budget and fatigue reads take a period and scope; the health check covers tracking, learning and audiences.
  "optimize_meta_budget",
  "detect_meta_creative_fatigue",
  "meta_account_health",
  "ga4_report",
  "search_console_query",
  "google_ads_report",
  "list_client_categories",
] as const;

/**
 * Intents whose reply answers a question, so the writer gets the read tools.
 * The fixed picker flows (campaign create, copy, images, website services,
 * an approved copy variant) keep their own fixed steps.
 */
const WRITER_TOOL_INTENTS: ReadonlySet<RequestIntent> = new Set<RequestIntent>([
  "general",
  "custom",
  "chat",
  "followup",
  "audit",
  "strategy",
  "budget",
  "list_campaigns",
  "export",
  "optimize",
  "out_of_scope",
  // The model decides when to analyse a brand and render images, in the
  // standalone image flow and mid-way through campaign creation.
  "generate_creatives",
  "create_campaign",
]);

export function writerHasTools(intent: RequestIntent): boolean {
  return WRITER_TOOL_INTENTS.has(intent);
}

function normalizeActId(id: string): string {
  const trimmed = id.trim();
  return trimmed.startsWith("act_") ? trimmed : `act_${trimmed}`;
}

/**
 * The Meta tools take the account id from the model, so a call is checked
 * against the accounts mapped to the task's client before it runs.
 */
async function metaAccountRefusal(args: unknown, ctx: ToolContext): Promise<string | null> {
  const accountId =
    args && typeof args === "object" && typeof (args as { account_id?: unknown }).account_id === "string"
      ? (args as { account_id: string }).account_id
      : null;
  if (!accountId) return null;
  const { loadMappedMetaAccounts } = await import("@/lib/adspirer/resolve-meta-account");
  const mapped = (await loadMappedMetaAccounts(ctx.clientId)).filter((a) => a.access_status === "granted");
  const wanted = normalizeActId(accountId);
  if (mapped.some((a) => normalizeActId(a.meta_account_id) === wanted)) return null;
  return `Meta account ${accountId} is not mapped to this client; use the client's own account${
    mapped.length ? ` (${mapped.map((a) => a.meta_account_id).join(", ")})` : " (none is mapped: map one under Admin → Connections)"
  }.`;
}

/** Offered only when the client has a connected Shopify store (products and variants live, sales synced). */
const SHOPIFY_TOOLS = ["shopify_products", "shopify_variants", "shopify_sales"] as const;

/** Offered only when the client sells from a Meta catalogue (Commerce Manager) and catalogue access works. */
const CATALOG_TOOLS = ["meta_catalogs", "meta_catalog_health", "meta_catalog_products", "meta_catalog_feeds"] as const;

function buildToolSet(ctx: ToolContext, names: readonly string[]): ToolSet {
  const tools: ToolSet = {};

  for (const name of names) {
    if (classify(name) !== "diagnose") continue;
    const registered = getTool(name);
    if (!registered) continue;

    tools[name] = tool({
      description: registered.description,
      inputSchema: registered.inputSchema,
      execute: async (args: unknown) => {
        try {
          const refusal = await metaAccountRefusal(args, ctx);
          if (refusal) return { error: true, tool: name, message: refusal };
          const result = await invokeTool(name, args, ctx);
          return result ?? { ok: true };
        } catch (error) {
          return {
            error: true,
            tool: name,
            message: error instanceof Error ? error.message : String(error),
          };
        }
      },
    });
  }

  return tools;
}

export function buildWorkspaceReadToolSet(ctx: ToolContext): ToolSet {
  return buildToolSet(ctx, WORKSPACE_READ_ALLOWLIST);
}

/** Longest the chat waits on catalogue discovery before deciding whether to offer the catalogue tools. */
export const CATALOG_GATE_TIMEOUT_MS = 2000;

/**
 * Whether to offer the catalogue tools, without holding the chat up on a slow discovery: an ok
 * discovery within CATALOG_GATE_TIMEOUT_MS offers them, a failure state or a thrown error leaves
 * them out, and a timeout offers them anyway (they return typed failure states themselves) while
 * the discovery carries on in the background and warms the cache.
 */
export async function catalogueToolsOffered(clientId: string, timeoutMs: number = CATALOG_GATE_TIMEOUT_MS): Promise<boolean> {
  const discovery = (async () => {
    const { getClientCommerce } = await import("@/lib/meta/catalog/service");
    return (await getClientCommerce(clientId)).state === "ok";
  })().catch(() => false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const outcome = await Promise.race([discovery, timedOut]);
    return outcome === "timeout" ? true : outcome;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The base read set plus the Shopify tools when the client has a connected
 * store, and the catalogue tools when the client sells from a Meta catalogue.
 * The two checks run in parallel; if either can't be read its tools are left out
 * (a slow catalogue discovery offers its tools anyway: see catalogueToolsOffered).
 */
export async function buildWorkspaceReadToolSetForClient(ctx: ToolContext): Promise<ToolSet> {
  const base = buildWorkspaceReadToolSet(ctx);
  const [shopify, catalogue] = await Promise.all([
    (async () => {
      try {
        const { getConnection } = await import("@/lib/shopify/store");
        return (await getConnection(ctx.clientId)) !== null;
      } catch {
        return false;
      }
    })(),
    catalogueToolsOffered(ctx.clientId),
  ]);
  return {
    ...base,
    ...(shopify ? buildToolSet(ctx, SHOPIFY_TOOLS) : {}),
    ...(catalogue ? buildToolSet(ctx, CATALOG_TOOLS) : {}),
  };
}

export function workspaceReadToolNames(): string[] {
  return WORKSPACE_READ_ALLOWLIST.filter((name) => classify(name) === "diagnose" && getTool(name));
}

/** @deprecated The audit writer now gets the full read set: use buildWorkspaceReadToolSet. */
export const buildAuditDiagnoseToolSet = buildWorkspaceReadToolSet;
/** @deprecated Use workspaceReadToolNames. */
export const auditDiagnoseToolNames = workspaceReadToolNames;
