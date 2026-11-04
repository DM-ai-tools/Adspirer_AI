import { loadMappedMetaAccounts } from "@/lib/adspirer/resolve-meta-account";
import { getConfig } from "@/lib/config";
import { DEMO_CATALOGS, demoCatalogProducts, demoCatalogSnapshot, demoCatalogUses } from "@/lib/meta/catalog/demo";
import { CatalogAccessError, catalogAccessReason } from "@/lib/meta/catalog/errors";
import { evaluateCatalog, type CatalogAdSetUse, type CatalogFinding, type LearningLink } from "@/lib/meta/catalog/findings";
import { fetchCatalogSnapshot, listCatalogProducts } from "@/lib/meta/catalog/snapshot";
import type { CatalogGraph, CatalogProduct, CatalogProductIssue, CatalogSnapshot } from "@/lib/meta/catalog/types";
import { getUserMetaToken } from "@/lib/meta/get-user-token";
import { MetaGraphClient } from "@/lib/meta/graph-client";

type Row = Record<string, unknown>;
type List = { data?: Row[]; paging?: { cursors?: { after?: string }; next?: string } };

export type ClientCatalog = { id: string; name: string; productCount: number };
/** An ad set selling a product set, with the catalogue that set belongs to. */
export type ClientCatalogUse = CatalogAdSetUse & { catalogId: string };

type FailureState = "not_connected" | "missing_permission" | "no_ad_account" | "no_catalog";
type Failure = { state: FailureState; message: string };

export type CommerceState = { state: "ok"; catalogs: ClientCatalog[]; uses: ClientCatalogUse[] } | Failure;

export type CatalogReport =
  | {
      state: "ok";
      snapshot: CatalogSnapshot;
      findings: CatalogFinding[];
      learningLinks: LearningLink[];
      uses: ClientCatalogUse[];
    }
  | Failure;

const MESSAGES: Record<FailureState, string> = {
  missing_permission:
    "Facebook is connected without catalogue access. Reconnect Facebook and allow catalogue (Commerce Manager) access.",
  not_connected: "Facebook is not connected. Connect it under Admin → Connections.",
  no_ad_account: "No Meta ad account is mapped to this client. Map one under Admin → Connections.",
  no_catalog: "No catalogue is linked to this client's ad accounts.",
};

const failure = (state: FailureState): Failure => ({ state, message: MESSAGES[state] });

const ADSET_PAGE_SIZE = 500;
const MAX_ADSET_PAGES = 5;
const REPORT_TTL_MS = 5 * 60_000;

const normalizeAct = (id: string): string => (id.startsWith("act_") ? id : `act_${id}`);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Same statuses the audit reads from learning_stage_info; anything else is unknown. */
function learningStatusOf(v: unknown): CatalogAdSetUse["learningStatus"] {
  const status = str((v as Row | null | undefined)?.status);
  return status === "LEARNING" || status === "SUCCESS" || status === "FAIL" ? status : null;
}

async function listAdSets(graph: CatalogGraph, accountId: string): Promise<Row[]> {
  const out: Row[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_ADSET_PAGES; page++) {
    const res = await graph.get<List>(`${accountId}/adsets`, {
      fields: "id,name,campaign_id,effective_status,learning_stage_info,promoted_object",
      limit: ADSET_PAGE_SIZE,
      ...(after ? { after } : {}),
    });
    out.push(...(res.data ?? []));
    after = res.paging?.next ? res.paging.cursors?.after : undefined;
    if (!after) break;
  }
  return out;
}

/**
 * Finds the catalogues a client sells from, by reading which product sets its ad sets promote.
 * Ad sets with no product set are ignored. Missing catalogue permission while reading a
 * product set throws CatalogAccessError.
 */
export async function discoverClientCatalogs(
  graph: CatalogGraph,
  accountIds: string[],
): Promise<{ catalogs: ClientCatalog[]; uses: ClientCatalogUse[] }> {
  const accounts = [...new Set(accountIds.map(normalizeAct))];
  const perAccount = await Promise.all(
    accounts.map(async (accountId) => ({ accountId, adSets: await listAdSets(graph, accountId) })),
  );

  const pending: Array<Omit<ClientCatalogUse, "catalogId">> = [];
  for (const { accountId, adSets } of perAccount) {
    for (const a of adSets) {
      const id = str(a.id);
      const productSetId = str((a.promoted_object as Row | undefined)?.product_set_id);
      if (!id || !productSetId) continue;
      pending.push({
        adSetId: id,
        adSetName: str(a.name) ?? id,
        campaignId: str(a.campaign_id) ?? "",
        accountId,
        productSetId,
        learningStatus: learningStatusOf(a.learning_stage_info),
        effectiveStatus: str(a.effective_status) ?? "",
      });
    }
  }

  const setIds = [...new Set(pending.map((u) => u.productSetId))];
  const catalogOfSet = new Map<string, ClientCatalog>();
  await Promise.all(
    setIds.map(async (setId) => {
      try {
        const res = await graph.get<Row>(setId, { fields: "product_catalog{id,name,product_count}" });
        const catalog = res.product_catalog as Row | undefined;
        const id = str(catalog?.id);
        if (id) catalogOfSet.set(setId, { id, name: str(catalog?.name) ?? id, productCount: num(catalog?.product_count) });
      } catch (error) {
        const reason = catalogAccessReason(error);
        if (reason === "missing_permission") {
          throw new CatalogAccessError(reason, error instanceof Error ? error.message : String(error));
        }
        // A set that no longer exists simply has no catalogue to report on.
        if (reason !== "not_found") throw error;
      }
    }),
  );

  const catalogs = new Map<string, ClientCatalog>();
  const uses: ClientCatalogUse[] = [];
  for (const u of pending) {
    const catalog = catalogOfSet.get(u.productSetId);
    if (!catalog) continue;
    catalogs.set(catalog.id, catalog);
    uses.push({ ...u, catalogId: catalog.id });
  }
  return { catalogs: [...catalogs.values()], uses };
}

async function connectedGraph(
  clientId: string,
): Promise<{ ok: true; graph: CatalogGraph; accountIds: string[]; userId: string | null } | { ok: false; result: Failure }> {
  const accounts = (await loadMappedMetaAccounts(clientId)).filter((a) => a.access_status === "granted");
  if (accounts.length === 0) return { ok: false, result: failure("no_ad_account") };

  let token: Awaited<ReturnType<typeof getUserMetaToken>>;
  try {
    token = await getUserMetaToken();
  } catch {
    return { ok: false, result: failure("not_connected") };
  }
  return {
    ok: true,
    graph: new MetaGraphClient(token.accessToken),
    accountIds: accounts.map((a) => normalizeAct(a.meta_account_id)),
    userId: token.metaUserId,
  };
}

function demoCommerce(): CommerceState {
  return { state: "ok", catalogs: DEMO_CATALOGS, uses: demoCatalogUses() };
}

export async function getClientCommerce(clientId: string): Promise<CommerceState> {
  if (getConfig().isDemoMode) return demoCommerce();

  const conn = await connectedGraph(clientId);
  if (!conn.ok) return conn.result;
  try {
    const { catalogs, uses } = await discoverClientCatalogs(conn.graph, conn.accountIds);
    if (catalogs.length === 0) return failure("no_catalog");
    return { state: "ok", catalogs, uses };
  } catch (error) {
    if (error instanceof CatalogAccessError && error.reason === "missing_permission") return failure("missing_permission");
    throw error;
  }
}

/** Module-level snapshot cache keyed `${userId}:${catalogId}`; findings are recomputed from fresh ad set data. */
const reportCache = new Map<string, { at: number; setKey: string; snapshot: CatalogSnapshot }>();

export function resetCatalogReportCache(): void {
  reportCache.clear();
}

export async function getCatalogReport(clientId: string, catalogId: string): Promise<CatalogReport> {
  if (getConfig().isDemoMode) {
    const demo = demoCommerce();
    if (demo.state !== "ok" || !demo.catalogs.some((c) => c.id === catalogId)) return failure("no_catalog");
    const snapshot = demoCatalogSnapshot();
    const uses = demo.uses.filter((u) => u.catalogId === catalogId);
    return { state: "ok", snapshot, uses, ...evaluateCatalog(snapshot, uses) };
  }

  const conn = await connectedGraph(clientId);
  if (!conn.ok) return conn.result;

  try {
    // Always discover first: the catalogue must belong to this client, whatever is cached.
    const { catalogs, uses: allUses } = await discoverClientCatalogs(conn.graph, conn.accountIds);
    if (!catalogs.some((c) => c.id === catalogId)) return failure("no_catalog");

    const uses = allUses.filter((u) => u.catalogId === catalogId);
    const productSetIds = [...new Set(uses.map((u) => u.productSetId))].sort();
    const setKey = productSetIds.join(",");
    // Without a known user there is nothing safe to key the cache on, so skip it.
    const key = conn.userId ? `${conn.userId}:${catalogId}` : null;

    let snapshot: CatalogSnapshot;
    const cached = key ? reportCache.get(key) : undefined;
    if (cached && cached.setKey === setKey && Date.now() - cached.at < REPORT_TTL_MS) {
      snapshot = cached.snapshot;
    } else {
      snapshot = await fetchCatalogSnapshot(conn.graph, catalogId, { productSetIds });
      if (key) reportCache.set(key, { at: Date.now(), setKey, snapshot });
    }
    return { state: "ok", snapshot, uses, ...evaluateCatalog(snapshot, uses) };
  } catch (error) {
    if (error instanceof CatalogAccessError) {
      return error.reason === "missing_permission" ? failure("missing_permission") : failure("no_catalog");
    }
    throw error;
  }
}

export type CatalogProductsResult = { state: "ok"; products: CatalogProduct[]; next: string | null } | Failure;

/**
 * One page of a catalogue's products. Same ownership check as getCatalogReport: the
 * catalogue must be one this client's ad sets sell from.
 */
export async function listClientCatalogProducts(
  clientId: string,
  catalogId: string,
  opts: { issue?: CatalogProductIssue; after?: string; limit?: number } = {},
): Promise<CatalogProductsResult> {
  if (getConfig().isDemoMode) {
    const demo = demoCommerce();
    if (demo.state !== "ok" || !demo.catalogs.some((c) => c.id === catalogId)) return failure("no_catalog");
    return { state: "ok", products: demoCatalogProducts(opts.issue), next: null };
  }

  const conn = await connectedGraph(clientId);
  if (!conn.ok) return conn.result;

  try {
    const { catalogs } = await discoverClientCatalogs(conn.graph, conn.accountIds);
    if (!catalogs.some((c) => c.id === catalogId)) return failure("no_catalog");
    const page = await listCatalogProducts(conn.graph, catalogId, opts);
    return { state: "ok", ...page };
  } catch (error) {
    if (error instanceof CatalogAccessError) {
      return error.reason === "missing_permission" ? failure("missing_permission") : failure("no_catalog");
    }
    if (catalogAccessReason(error) === "missing_permission") return failure("missing_permission");
    throw error;
  }
}
