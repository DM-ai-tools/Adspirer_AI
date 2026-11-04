import { z } from "zod";
import { registerTool } from "@/lib/tools/registry";

/**
 * Read-only Meta catalogue (Commerce Manager) tools. The client always comes from the task
 * context, never from the model, and a catalogue id is checked against the client's own
 * ad sets before anything is read. Offered only when the client sells from a catalogue.
 */

/** Most products one call returns. Client-side issue filters can scan past `limit`, so this caps the page. */
const MAX_PRODUCTS = 50;
const PAGE_LIMIT = 25;
/** Most ad sets listed per catalogue by meta_catalogs; ad_set_count carries the full number. */
const MAX_AD_SETS = 20;

type Failure = { state: string; message: string };
type ToolError = { error: true; source: "Meta"; message: string; missing_permission?: true };

const catalogIdSchema = z.object({ catalog_id: z.string().trim().min(1).max(64) });

function failureResult(f: Failure): ToolError {
  return f.state === "missing_permission"
    ? { error: true, source: "Meta", missing_permission: true, message: f.message }
    : { error: true, source: "Meta", message: f.message };
}

/** The service lets rate limits and 5xx propagate; the model gets a readable error instead of a throw. */
function thrownResult(error: unknown): ToolError {
  return { error: true, source: "Meta", message: error instanceof Error ? error.message : String(error) };
}

export const metaCatalogsTool = registerTool({
  name: "meta_catalogs",
  description: [
    "The Meta catalogues (Commerce Manager) this client sells from, with their product counts and which ad sets use each one (with each ad set's learning status).",
    "Use it first on any ecommerce, catalogue or product-ad question to get the catalog_id the other catalogue tools need.",
  ].join(" "),
  inputSchema: z.object({}),
  async execute(_args, ctx) {
    try {
      const { getClientCommerce } = await import("@/lib/meta/catalog/service");
      const commerce = await getClientCommerce(ctx.clientId);
      if (commerce.state !== "ok") return failureResult(commerce);
      return {
        source: "Meta",
        catalogs: commerce.catalogs.map((c) => {
          const uses = commerce.uses.filter((u) => u.catalogId === c.id);
          // Learning-limited (FAIL) ad sets first: they are what the operator usually asks about.
          const ordered = [...uses.filter((u) => u.learningStatus === "FAIL"), ...uses.filter((u) => u.learningStatus !== "FAIL")];
          return {
            id: c.id,
            name: c.name,
            product_count: c.productCount,
            ad_set_count: uses.length,
            ad_sets: ordered.slice(0, MAX_AD_SETS).map((u) => ({
              id: u.adSetId,
              name: u.adSetName,
              campaign_id: u.campaignId,
              account_id: u.accountId,
              product_set_id: u.productSetId,
              learning_status: u.learningStatus,
              status: u.effectiveStatus,
            })),
          };
        }),
      };
    } catch (error) {
      return thrownResult(error);
    }
  },
});

export const metaCatalogHealthTool = registerTool({
  name: "meta_catalog_health",
  description: [
    "Health of one Meta catalogue: product and out-of-stock counts, Meta's own diagnostics (rejected and errored products), product sets with in-stock counts, pixel event matching, plus ranked findings and, for each ad set in learning FAIL (learning limited), whether the catalogue is a likely contributor.",
    "Use it for catalogue or product ads, learning limited on catalogue ad sets, out of stock or rejected products, and pixel matching. Quote the numbers it returns.",
    "Each learning link's verdict is likely_contributor or healthy; only say the catalogue explains learning limited for likely_contributor.",
  ].join(" "),
  inputSchema: catalogIdSchema,
  async execute(args, ctx) {
    try {
      const { getCatalogReport } = await import("@/lib/meta/catalog/service");
      const report = await getCatalogReport(ctx.clientId, args.catalog_id);
      if (report.state !== "ok") return failureResult(report);
      const s = report.snapshot;
      return {
        source: "Meta",
        catalog_id: s.id,
        name: s.name,
        vertical: s.vertical,
        product_count: s.productCount,
        out_of_stock_count: s.outOfStockCount,
        diagnostics: s.diagnostics.map((d) => ({
          type: d.type,
          severity: d.severity,
          title: d.title,
          affected_items: d.affectedItems,
          children: d.children.map((c) => ({ type: c.type, description: c.description, affected_items: c.affectedItems })),
        })),
        product_sets: s.productSets.map((p) => ({
          id: p.id,
          name: p.name,
          filter: p.filter,
          product_count: p.productCount,
          in_stock_count: p.inStockCount,
        })),
        events: s.events.map((e) => {
          const total = e.matched + e.unmatched;
          return {
            event: e.event,
            pixel_id: e.pixelId,
            matched: e.matched,
            unmatched: e.unmatched,
            matched_other_catalogs: e.matchedOtherCatalogs,
            match_rate: total > 0 ? Math.round((e.matched / total) * 1000) / 1000 : null,
          };
        }),
        pixel_ids: s.pixelIds,
        feed_count: s.feeds.length,
        findings: report.findings,
        learning_links: report.learningLinks,
        ...(s.warnings.length ? { warnings: s.warnings } : {}),
        fetched_at: s.fetchedAt,
      };
    } catch (error) {
      return thrownResult(error);
    }
  },
});

export const metaCatalogProductsTool = registerTool({
  name: "meta_catalog_products",
  description: [
    "One page (up to 50) of a Meta catalogue's products with availability, review status, price and the errors Meta attached.",
    "Pass issue to narrow to out_of_stock, rejected, or any_error products. Pass the returned next cursor as after to read the following page.",
    "Use it to name the products behind an out-of-stock or rejected count from meta_catalog_health.",
  ].join(" "),
  inputSchema: catalogIdSchema.extend({
    issue: z.enum(["out_of_stock", "rejected", "any_error"]).optional(),
    after: z.string().trim().min(1).max(500).optional(),
  }),
  async execute(args, ctx) {
    try {
      const { listClientCatalogProducts } = await import("@/lib/meta/catalog/service");
      const page = await listClientCatalogProducts(ctx.clientId, args.catalog_id, {
        ...(args.issue ? { issue: args.issue } : {}),
        ...(args.after ? { after: args.after } : {}),
        limit: PAGE_LIMIT,
      });
      if (page.state !== "ok") return failureResult(page);
      const shown = page.products.slice(0, MAX_PRODUCTS);
      return {
        source: "Meta",
        catalog_id: args.catalog_id,
        ...(args.issue ? { issue: args.issue } : {}),
        products: shown.map((p) => ({
          id: p.id,
          retailer_id: p.retailerId,
          name: p.name,
          availability: p.availability,
          review_status: p.reviewStatus,
          visibility: p.visibility,
          price: p.price,
          url: p.url,
          errors: p.errors.map((e) => ({ type: e.type, priority: e.priority, title: e.title })),
        })),
        next: page.next,
        ...(page.products.length > shown.length ? { truncated: true } : {}),
      };
    } catch (error) {
      return thrownResult(error);
    }
  },
});

export const metaCatalogFeedsTool = registerTool({
  name: "meta_catalog_feeds",
  description: [
    "The product feeds of one Meta catalogue: name, product count, schedule, and the last upload with its time and error and warning counts.",
    "Use it when products look stale, prices or stock are out of date, or the operator asks about feeds or uploads.",
  ].join(" "),
  inputSchema: catalogIdSchema,
  async execute(args, ctx) {
    try {
      const { getCatalogReport } = await import("@/lib/meta/catalog/service");
      const report = await getCatalogReport(ctx.clientId, args.catalog_id);
      if (report.state !== "ok") return failureResult(report);
      return {
        source: "Meta",
        catalog_id: report.snapshot.id,
        feeds: report.snapshot.feeds.map((f) => ({
          id: f.id,
          name: f.name,
          product_count: f.productCount,
          schedule_interval: f.scheduleInterval,
          schedule_url: f.scheduleUrl,
          last_upload: f.lastUpload,
        })),
        fetched_at: report.snapshot.fetchedAt,
      };
    } catch (error) {
      return thrownResult(error);
    }
  },
});
