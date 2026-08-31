import { MetaGraphClient } from "@/lib/meta/graph-client";
import { getUserMetaToken } from "@/lib/meta/get-user-token";
import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";

function normalizeAccountId(accountId: string): string {
  return accountId.startsWith("act_") ? accountId : `act_${accountId}`;
}

export type MetaPageOption = {
  id: string;
  name: string;
  source: string;
};

async function loadBusinessIdForAccount(
  accountId: string,
): Promise<string | null> {
  const actId = normalizeAccountId(accountId);
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    const row = getDemoStore().connectedMetaAccounts.find(
      (a) => a.meta_account_id === actId,
    );
    return row?.business_id ?? null;
  }
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("connected_meta_accounts")
    .select("business_id, raw_metadata")
    .eq("external_account_id", actId)
    .maybeSingle();
  const fromRow = data?.business_id as string | undefined;
  if (fromRow) return fromRow;
  const raw = data?.raw_metadata as Record<string, unknown> | null;
  const fromMeta =
    typeof raw?.business_id === "string" ? raw.business_id : null;
  return fromMeta;
}

async function fetchPageRows(
  graph: MetaGraphClient,
  path: string,
): Promise<Array<{ id?: string; name?: string }>> {
  const data = await graph.get<{
    data?: Array<{ id?: string; name?: string }>;
  }>(path, { fields: "id,name", limit: 50 });
  return data.data ?? [];
}

function pageIdFromObjectStorySpec(spec: unknown): string | null {
  if (!spec) return null;
  try {
    const parsed =
      typeof spec === "string" ? (JSON.parse(spec) as unknown) : spec;
    if (parsed && typeof parsed === "object" && "page_id" in parsed) {
      const id = (parsed as { page_id?: unknown }).page_id;
      return typeof id === "string" || typeof id === "number"
        ? String(id)
        : null;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * List Facebook Pages usable for ads on this ad account (newest sources first).
 */
export async function listFacebookPagesForAdAccount(
  graph: MetaGraphClient,
  accountId: string,
  options?: { businessId?: string | null },
): Promise<MetaPageOption[]> {
  const id = normalizeAccountId(accountId);
  const pages: MetaPageOption[] = [];
  const seen = new Set<string>();

  const add = (row: { id?: string; name?: string }, source: string) => {
    if (!row.id) return;
    const pageId = String(row.id);
    if (seen.has(pageId)) return;
    seen.add(pageId);
    pages.push({
      id: pageId,
      name: String(row.name ?? pageId),
      source,
    });
  };

  const accountEdges: Array<[string, string]> = [
    [`${id}/promote_pages`, "promote_pages"],
    [`${id}/assigned_pages`, "assigned_pages"],
    [`${id}/client_pages`, "client_pages"],
  ];

  for (const [path, source] of accountEdges) {
    try {
      const rows = await fetchPageRows(graph, path);
      for (const row of rows) add(row, source);
    } catch {
      // try next edge
    }
  }

  try {
    const rows = await fetchPageRows(graph, "me/accounts");
    for (const row of rows) add(row, "me/accounts");
  } catch {
    // pages_show_list may be missing until user reconnects Facebook
  }

  const businessId = options?.businessId ?? (await loadBusinessIdForAccount(id));
  if (businessId) {
    for (const [path, source] of [
      [`${businessId}/owned_pages`, "business_owned_pages"],
      [`${businessId}/client_pages`, "business_client_pages"],
    ] as const) {
      try {
        const rows = await fetchPageRows(graph, path);
        for (const row of rows) add(row, source);
      } catch {
        // continue
      }
    }
  }

  try {
    const ads = await graph.get<{
      data?: Array<{
        creative?: { object_story_spec?: unknown };
      }>;
    }>(`${id}/ads`, {
      fields: "creative{object_story_spec}",
      limit: 25,
    });
    for (const ad of ads.data ?? []) {
      const pageId = pageIdFromObjectStorySpec(ad.creative?.object_story_spec);
      if (pageId) {
        add({ id: pageId, name: "From existing ad in account" }, "existing_ad");
      }
    }
  } catch {
    // optional fallback
  }

  return pages;
}

export function formatMissingPageHelp(accountId: string): string {
  return [
    `No Facebook Page was found for ad account ${normalizeAccountId(accountId)}.`,
    "Connecting the ad account in Adspirer does not automatically grant Page access.",
    "",
    "Fix options:",
    "1. In Meta Business Settings → Accounts → Pages — assign your Page to this ad account.",
    "2. Reconnect Facebook in Connections (we request Page permission) and Sync accounts.",
    "3. Add facebook_page_id manually in Edit — find it in Meta Business Suite → Settings → Page info, or facebook.com/<your-page>/about.",
  ].join("\n");
}

/**
 * Pick a Facebook Page the ad account can promote. Video/link creatives require
 * `page_id` on object_story_spec.
 */
export async function resolvePromotePageId(
  graph: MetaGraphClient,
  accountId: string,
  options?: { businessId?: string | null },
): Promise<string | null> {
  const pages = await listFacebookPagesForAdAccount(graph, accountId, options);
  return pages[0]?.id ?? null;
}

/** Resolve page ID using the logged-in user's Meta OAuth token (Workspace V2). */
export async function resolveFacebookPageIdForAccount(
  accountId: string,
  explicit?: string | null,
): Promise<string> {
  if (explicit?.trim()) return explicit.trim();
  const { accessToken } = await getUserMetaToken();
  const graph = new MetaGraphClient(accessToken);
  const businessId = await loadBusinessIdForAccount(accountId);
  const pageId = await resolvePromotePageId(graph, accountId, { businessId });
  if (pageId) return pageId;
  throw new Error(formatMissingPageHelp(accountId));
}

/** List pages for UI / debugging (uses current user's OAuth token). */
export async function listFacebookPagesForAccountId(
  accountId: string,
): Promise<MetaPageOption[]> {
  const { accessToken } = await getUserMetaToken();
  const graph = new MetaGraphClient(accessToken);
  const businessId = await loadBusinessIdForAccount(accountId);
  return listFacebookPagesForAdAccount(graph, accountId, { businessId });
}
