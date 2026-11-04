import { loadMappedMetaAccounts } from "@/lib/adspirer/resolve-meta-account";
import { getConfig } from "@/lib/config";
import { DEMO_CATALOGS, demoCatalogProducts, demoCatalogSnapshot, demoCatalogUses } from "@/lib/meta/catalog/demo";
import { CatalogAccessError, catalogAccessReason, isPerObjectPermissionError } from "@/lib/meta/catalog/errors";
import { evaluateCatalog, isDeliveringStatus, type CatalogAdSetUse, type CatalogFinding, type LearningLink } from "@/lib/meta/catalog/findings";
import { fetchCatalogSnapshot, listCatalogProducts } from "@/lib/meta/catalog/snapshot";
import type { CatalogGraph, CatalogProduct, CatalogProductIssue, CatalogSnapshot } from "@/lib/meta/catalog/types";
import { getUserMetaToken } from "@/lib/meta/get-user-token";
import { MetaGraphClient } from "@/lib/meta/graph-client";

type Row = Record<string, unknown>;
type List = { data?: Row[]; paging?: { cursors?: { after?: string }; next?: string } };

export type ClientCatalog = { id: string; name: string; productCount: number };
/** An ad set selling a product set, with the catalogue that set belongs to. */
export type ClientCatalogUse = CatalogAdSetUse & { catalogId: string };

type FailureState = "not_connected" | "missing_permission" | "no_ad_account" | "no_catalog" | "catalogs_unreadable";
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

const MESSAGES: Record<Exclude<FailureState, "catalogs_unreadable">, string> = {
  missing_permission:
    "Facebook is connected without catalogue access. Reconnect Facebook and allow catalogue (Commerce Manager) access.",
  not_connected: "Facebook is not connected. Connect it under Admin → Connections.",
  no_ad_account: "No Meta ad account is mapped to this client. Map one under Admin → Connections.",
  no_catalog: "No catalogue is linked to this client's ad accounts.",
};

const failure = (state: Exclude<FailureState, "catalogs_unreadable">): Failure => ({ state, message: MESSAGES[state] });

export const EXPIRED_MESSAGE = "Your Facebook connection has expired. Reconnect Facebook.";
export const DISCOVERY_INCOMPLETE_MESSAGE =
  "Meta did not answer for every product set, so this client's catalogues could not be listed. Try again in a minute.";

/** Catalogue ad sets were found but none of their product sets could be read. */
export function catalogsUnreadable(adSetCount: number): Failure {
  const found = adSetCount === 1 ? "1 catalogue ad set found" : `${adSetCount} catalogue ad sets found`;
  return {
    state: "catalogs_unreadable",
    message: `${found}, but your Facebook login can't read their product sets (they may belong to another business you don't have access to).`,
  };
}

/** The failure an access error shows (an expired token reads as not connected), or null when it is not one. */
function accessFailure(error: unknown): Failure | null {
  const reason = error instanceof CatalogAccessError ? error.reason : catalogAccessReason(error);
  if (reason === "expired") return { state: "not_connected", message: EXPIRED_MESSAGE };
  if (reason === "missing_permission") return failure("missing_permission");
  return null;
}

const ADSET_PAGE_SIZE = 500;
const MAX_ADSET_PAGES = 5;
const REPORT_TTL_MS = 5 * 60_000;
const COMMERCE_TTL_MS = 5 * 60_000;
/** Most product set lookups in flight at once during discovery. */
export const PRODUCT_SET_CONCURRENCY = 6;

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

/** Runs `fn` over `items` with at most `limit` running at once; stops starting new ones after a throw. */
async function forEachLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const item = items[next++]!;
      try {
        await fn(item);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * Finds the catalogues a client sells from, by reading which product sets its ad sets promote.
 * Ad sets with no product set are ignored. Product sets are looked up at most
 * PRODUCT_SET_CONCURRENCY at a time. An app-level permission failure (or an expired token) while
 * reading a product set throws CatalogAccessError; a 10/200 permission error on one set is skipped
 * like an unreadable set, unless every set fails that way.
 */
export async function discoverClientCatalogs(
  graph: CatalogGraph,
  accountIds: string[],
): Promise<{
  catalogs: ClientCatalog[];
  uses: ClientCatalogUse[];
  /** Product sets whose catalogue could not be read and were left out. */
  skippedProductSets: number;
  /** False when a set was skipped for a reason other than being unreadable, so the result should not be cached. */
  complete: boolean;
  /** Ad sets that sell from a product set, whether or not its catalogue could be read. */
  catalogAdSets: number;
}> {
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
  let skippedProductSets = 0;
  let complete = true;
  let permissionSkipped = 0;
  let lastPermissionMessage = "";
  await forEachLimited(setIds, PRODUCT_SET_CONCURRENCY, async (setId) => {
    try {
      const res = await graph.get<Row>(setId, { fields: "product_catalog{id,name,product_count}" });
      const catalog = res.product_catalog as Row | undefined;
      const id = str(catalog?.id);
      if (id) catalogOfSet.set(setId, { id, name: str(catalog?.name) ?? id, productCount: num(catalog?.product_count) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reason = catalogAccessReason(error);
      if (reason === "expired") throw new CatalogAccessError("expired", message);
      if (reason === "missing_permission" && !isPerObjectPermissionError(error)) {
        // For example "(#100) This application has not been approved to use this api": app-wide.
        throw new CatalogAccessError(reason, message);
      }
      // One set the token cannot read (deleted, owned by another business, or a 10/200 permission
      // error on that set alone) must not fail the client's whole discovery: skip it and keep the
      // other sets' catalogues. A failure that is not a clear "unreadable set" (rate limit, network)
      // is skipped too but marks the result incomplete, so it is not cached and the next load retries.
      skippedProductSets += 1;
      if (reason === "missing_permission") {
        permissionSkipped += 1;
        lastPermissionMessage = message;
      } else if (reason !== "not_found") {
        complete = false;
      }
    }
  });
  // Every set refused with a permission error: that is the connection, not one set.
  if (setIds.length > 0 && permissionSkipped === setIds.length) {
    throw new CatalogAccessError("missing_permission", lastPermissionMessage);
  }

  const catalogs = new Map<string, ClientCatalog>();
  const uses: ClientCatalogUse[] = [];
  for (const u of pending) {
    const catalog = catalogOfSet.get(u.productSetId);
    if (!catalog) continue;
    catalogs.set(catalog.id, catalog);
    uses.push({ ...u, catalogId: catalog.id });
  }
  return { catalogs: [...catalogs.values()], uses, skippedProductSets, complete, catalogAdSets: pending.length };
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

type Discovered = Awaited<ReturnType<typeof discoverClientCatalogs>>;
type Connected = Extract<Awaited<ReturnType<typeof connectedGraph>>, { ok: true }>;

/**
 * Catalogue discovery per client and Meta user, kept for COMMERCE_TTL_MS. Holds only complete
 * discoveries (including "no catalogue"); permission failures, "catalogues unreadable" and thrown
 * errors are never cached, so a reconnect or newly granted access shows up at once. Keyed by
 * client, so one client never reads another's entry.
 */
const commerceCache = new Map<string, { at: number; value: Discovered }>();
/** Discoveries running now, keyed like commerceCache, so concurrent callers share one. */
const commerceInFlight = new Map<string, Promise<Discovered>>();

const cacheable = (d: Discovered): boolean => d.complete && !(d.catalogs.length === 0 && d.skippedProductSets > 0);

async function discoverCached(conn: Connected, clientId: string): Promise<Discovered> {
  // Without a known Meta user there is nothing safe to key on, so skip the cache.
  const key = conn.userId ? `${clientId}:${conn.userId}` : null;
  if (!key) return discoverClientCatalogs(conn.graph, conn.accountIds);
  const hit = commerceCache.get(key);
  if (hit && Date.now() - hit.at < COMMERCE_TTL_MS) return hit.value;
  const running = commerceInFlight.get(key);
  if (running) return running;
  const run = (async () => {
    try {
      const value = await discoverClientCatalogs(conn.graph, conn.accountIds);
      if (cacheable(value)) commerceCache.set(key, { at: Date.now(), value });
      return value;
    } finally {
      commerceInFlight.delete(key);
    }
  })();
  commerceInFlight.set(key, run);
  return run;
}

/**
 * Why a discovery with no readable catalogue shows nothing. Throws when the discovery was
 * incomplete (a rate limit or network failure), so callers show an error with a retry rather
 * than "no catalogue". Null when there are catalogues.
 */
function emptyDiscovery(d: Discovered): Failure | null {
  if (d.catalogs.length > 0) return null;
  if (!d.complete) throw new Error(DISCOVERY_INCOMPLETE_MESSAGE);
  if (d.skippedProductSets > 0) return catalogsUnreadable(d.catalogAdSets);
  return failure("no_catalog");
}

function demoCommerce(): CommerceState {
  return { state: "ok", catalogs: DEMO_CATALOGS, uses: demoCatalogUses() };
}

export async function getClientCommerce(clientId: string): Promise<CommerceState> {
  if (getConfig().isDemoMode) return demoCommerce();

  const conn = await connectedGraph(clientId);
  if (!conn.ok) return conn.result;
  try {
    const discovered = await discoverCached(conn, clientId);
    const empty = emptyDiscovery(discovered);
    if (empty) return empty;
    return { state: "ok", catalogs: discovered.catalogs, uses: discovered.uses };
  } catch (error) {
    const access = accessFailure(error);
    if (access) return access;
    throw error;
  }
}

/** Module-level snapshot cache keyed `${userId}:${catalogId}`; findings are recomputed from fresh ad set data. */
const reportCache = new Map<string, { at: number; setKey: string; snapshot: CatalogSnapshot }>();

export function resetCatalogReportCache(): void {
  reportCache.clear();
  commerceCache.clear();
  commerceInFlight.clear();
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
    // Discover first: the catalogue must belong to this client. The discovery cache is per client.
    const discovered = await discoverCached(conn, clientId);
    const empty = emptyDiscovery(discovered);
    if (empty) return empty;
    const { catalogs, uses: allUses } = discovered;
    if (!catalogs.some((c) => c.id === catalogId)) return failure("no_catalog");

    const uses = allUses.filter((u) => u.catalogId === catalogId);
    // Only product sets that delivering ad sets sell are counted (and judged); paused ones are skipped.
    const productSetIds = [...new Set(uses.filter((u) => isDeliveringStatus(u.effectiveStatus)).map((u) => u.productSetId))].sort();
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
    const access = accessFailure(error);
    if (access) return access;
    if (error instanceof CatalogAccessError) return failure("no_catalog");
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
    const discovered = await discoverCached(conn, clientId);
    const empty = emptyDiscovery(discovered);
    if (empty) return empty;
    if (!discovered.catalogs.some((c) => c.id === catalogId)) return failure("no_catalog");
    const page = await listCatalogProducts(conn.graph, catalogId, opts);
    return { state: "ok", ...page };
  } catch (error) {
    const access = accessFailure(error);
    if (access) return access;
    if (error instanceof CatalogAccessError) return failure("no_catalog");
    throw error;
  }
}
