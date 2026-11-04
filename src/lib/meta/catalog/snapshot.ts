import { catalogAccessReason, CatalogAccessError } from "@/lib/meta/catalog/errors";
import type {
  CatalogDiagnostic,
  CatalogEventMatch,
  CatalogFeed,
  CatalogGraph,
  CatalogProduct,
  CatalogProductIssue,
  CatalogProductSet,
  CatalogSnapshot,
} from "@/lib/meta/catalog/types";

type Row = Record<string, unknown>;
type List = { data?: Row[]; paging?: { cursors?: { after?: string }; next?: string }; summary?: { total_count?: number } };

const MAX_FEEDS = 10;
const IN_STOCK_FILTER = JSON.stringify({ availability: { eq: "in stock" } });

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown) => (typeof v === "string" && v ? v : null);
const rows = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : []);

async function settle<T>(label: string, warnings: string[], p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (error) {
    warnings.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function diagnosticFrom(row: Row): CatalogDiagnostic {
  return {
    type: str(row.type) ?? "UNKNOWN",
    severity: str(row.severity) ?? "UNKNOWN",
    title: str(row.title) ?? "",
    errorCode: row.error_code != null && Number.isFinite(Number(row.error_code)) ? Number(row.error_code) : null,
    affectedItems: num(row.number_of_affected_items),
    children: rows(row.diagnostics).map((c) => ({
      type: str(c.type) ?? "UNKNOWN",
      description: str(c.description) ?? "",
      affectedItems: num(c.number_of_affected_items),
    })),
  };
}

function eventsFrom(data: Row[]): CatalogEventMatch[] {
  const byKey = new Map<string, CatalogEventMatch>();
  for (const r of data) {
    const event = str(r.event);
    if (!event) continue;
    const pixelId = str((r.event_source as Row | undefined)?.id);
    const key = `${event}|${pixelId ?? ""}`;
    const row = byKey.get(key) ?? { event, pixelId, matched: 0, unmatched: 0, matchedOtherCatalogs: 0 };
    row.matched += num(r.total_matched_content_ids);
    row.unmatched += num(r.total_unmatched_content_ids);
    row.matchedOtherCatalogs += num(r.total_content_ids_matched_other_catalogs);
    byKey.set(key, row);
  }
  return [...byKey.values()];
}

async function loadFeeds(graph: CatalogGraph, catalogId: string, warnings: string[]): Promise<CatalogFeed[]> {
  const res = await graph.get<List>(`${catalogId}/product_feeds`, {
    fields: "id,name,product_count,schedule",
    limit: MAX_FEEDS,
  });
  return Promise.all(
    rows(res.data)
      .slice(0, MAX_FEEDS)
      .map(async (f): Promise<CatalogFeed> => {
        const id = String(f.id);
        const schedule = (f.schedule ?? {}) as Row;
        const uploads = await settle(
          `feed ${id} uploads`,
          warnings,
          graph.get<List>(`${id}/uploads`, { fields: "end_time,error_count,warning_count", limit: 1 }),
        );
        const last = rows(uploads?.data)[0];
        return {
          id,
          name: str(f.name) ?? id,
          productCount: num(f.product_count),
          scheduleUrl: str(schedule.url),
          scheduleInterval: str(schedule.interval),
          lastUpload: last
            ? { endTime: str(last.end_time), errorCount: num(last.error_count), warningCount: num(last.warning_count) }
            : null,
        };
      }),
  );
}

/**
 * Reads a catalogue's health: Meta's own diagnostics, product sets, feeds and
 * pixel matching. Only the catalogue lookup itself can fail the call; every
 * other part degrades to a warning. Product-level counts never page /products.
 */
export async function fetchCatalogSnapshot(
  graph: CatalogGraph,
  catalogId: string,
  opts: { productSetIds?: string[] } = {},
): Promise<CatalogSnapshot> {
  let basics: Row;
  try {
    basics = await graph.get<Row>(catalogId, { fields: "id,name,vertical,product_count" });
  } catch (error) {
    const reason = catalogAccessReason(error);
    if (reason) throw new CatalogAccessError(reason, error instanceof Error ? error.message : String(error));
    throw error;
  }

  const warnings: string[] = [];
  const used = new Set(opts.productSetIds ?? []);
  const [diagnostics, sets, feeds, events, sources] = await Promise.all([
    settle("diagnostics", warnings, graph.get<List>(`${catalogId}/diagnostics`)),
    settle(
      "product sets",
      warnings,
      graph.get<List>(`${catalogId}/product_sets`, { fields: "id,name,product_count,filter", limit: 100 }),
    ),
    settle("feeds", warnings, loadFeeds(graph, catalogId, warnings)),
    settle("event stats", warnings, graph.get<List>(`${catalogId}/event_stats`)),
    settle("pixels", warnings, graph.get<List>(`${catalogId}/external_event_sources`)),
  ]);

  const productSets: CatalogProductSet[] = await Promise.all(
    rows(sets?.data).map(async (s): Promise<CatalogProductSet> => {
      const id = String(s.id);
      let inStockCount: number | null = null;
      if (used.has(id)) {
        const counted = await settle(
          `in-stock count for product set ${id}`,
          warnings,
          graph.get<List>(`${id}/products`, { filter: IN_STOCK_FILTER, summary: "true", limit: 1 }),
        );
        if (counted?.summary?.total_count != null) inStockCount = num(counted.summary.total_count);
      }
      return {
        id,
        name: str(s.name) ?? id,
        filter: str(s.filter),
        productCount: num(s.product_count),
        inStockCount,
      };
    }),
  );

  const diagnosticRows = diagnostics ? rows(diagnostics.data).map(diagnosticFrom) : [];
  const outOfStockCount = diagnostics
    ? diagnosticRows
        .flatMap((d) => d.children)
        .filter((c) => c.type === "PRODUCT_OUT_OF_STOCK")
        .reduce((sum, c) => sum + c.affectedItems, 0)
    : null;

  return {
    id: str(basics.id) ?? catalogId,
    name: str(basics.name) ?? catalogId,
    vertical: str(basics.vertical),
    productCount: num(basics.product_count),
    diagnostics: diagnosticRows,
    productSets,
    feeds: feeds ?? [],
    events: eventsFrom(rows(events?.data)),
    pixelIds: rows(sources?.data).map((r) => String(r.id)),
    outOfStockCount,
    warnings,
    fetchedAt: new Date().toISOString(),
  };
}

const ISSUE_FILTERS: Partial<Record<CatalogProductIssue, string>> = {
  out_of_stock: JSON.stringify({ availability: { eq: "out of stock" } }),
  rejected: JSON.stringify({ review_status: { eq: "rejected" } }),
};

/**
 * One page of products, optionally narrowed to an issue. Meta has no
 * server-side "has any error" filter, so `any_error` keeps the page's rows
 * that carry errors (a page can therefore come back short).
 */
export async function listCatalogProducts(
  graph: CatalogGraph,
  catalogId: string,
  opts: { issue?: CatalogProductIssue; after?: string; limit?: number },
): Promise<{ products: CatalogProduct[]; next: string | null }> {
  const filter = opts.issue ? ISSUE_FILTERS[opts.issue] : undefined;
  const res = await graph.get<List>(`${catalogId}/products`, {
    fields: "id,retailer_id,name,availability,review_status,visibility,url,image_url,price,errors",
    limit: Math.min(Math.max(opts.limit ?? 25, 1), 100),
    ...(filter ? { filter } : {}),
    ...(opts.after ? { after: opts.after } : {}),
  });
  let products = rows(res.data).map(
    (p): CatalogProduct => ({
      id: String(p.id),
      retailerId: str(p.retailer_id) ?? "",
      name: str(p.name),
      availability: str(p.availability),
      reviewStatus: str(p.review_status),
      visibility: str(p.visibility),
      url: str(p.url),
      imageUrl: str(p.image_url),
      price: str(p.price),
      errors: rows(p.errors).map((e) => ({
        type: str(e.error_type) ?? "UNKNOWN",
        priority: str(e.error_priority) ?? "",
        title: str(e.title) ?? "",
      })),
    }),
  );
  if (opts.issue === "any_error") products = products.filter((p) => p.errors.length > 0);
  return { products, next: res.paging?.next ? (res.paging.cursors?.after ?? null) : null };
}
