import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/observability/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/shopify/live", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/shopify/live")>();
  return {
    ...actual,
    liveFindProducts: vi.fn(actual.liveFindProducts),
    liveLookupVariants: vi.fn(actual.liveLookupVariants),
  };
});
vi.mock("@/lib/shopify/query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/shopify/query")>();
  return { ...actual, querySales: vi.fn(actual.querySales) };
});

import { buildWorkspaceReadToolSet, buildWorkspaceReadToolSetForClient, workspaceReadToolNames } from "@/lib/agent/diagnose-tools-ai";
import { buildClientContext } from "@/lib/agent/context-builder";
import { buildStaticSystemPromptV2 } from "@/lib/agent/prompts-v2";
import { resetConfigCache } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { LiveShopifyError, liveFindProducts, liveLookupVariants } from "@/lib/shopify/live";
import { MOCK_SHOP, mockShopifySales } from "@/lib/shopify/mock";
import { querySales } from "@/lib/shopify/query";
import { replaceSales, saveConnection } from "@/lib/shopify/store";
import { getTool } from "@/lib/tools/registry";
import { humanToolLabel, humanToolProgressLabel } from "@/lib/tools/display-labels";
import { classify } from "@/lib/tools/policy";
import { invokeTool, type ToolContext } from "@/lib/tools/registry";
import "@/lib/tools/diagnose";

const CT = "client_clicktrends";
const TR = "client_trafficradius";
const NAMES = ["shopify_products", "shopify_variants", "shopify_sales"];
const ctx = (clientId: string): ToolContext => ({ clientId, userId: "user_admin", taskId: "task_x" });
type Result = Record<string, unknown> & { rows?: Array<Record<string, unknown>> };
const call = async (name: string, args: unknown, clientId = CT) => (await invokeTool(name, args, ctx(clientId))) as Result;

async function seed(connected = true, syncedAgoMs: number | null = 3 * 3_600_000) {
  const s = getDemoStore();
  s.shopifyConnections.length = 0;
  s.shopifySales.length = 0;
  if (!connected) return;
  const conn = await saveConnection({
    clientId: CT,
    shopDomain: MOCK_SHOP.domain,
    shopName: MOCK_SHOP.name,
    currency: MOCK_SHOP.currency,
    scopes: [],
    accessTokenEncrypted: "v1:SECRET-CIPHERTEXT",
    connectedBy: null,
  });
  if (syncedAgoMs !== null) await replaceSales(CT, mockShopifySales(CT));
  const row = s.shopifyConnections.find((c) => c.id === conn.id)!;
  row.last_sync_at = syncedAgoMs === null ? null : new Date(Date.now() - syncedAgoMs).toISOString();
  row.last_sync_status = syncedAgoMs === null ? "never" : "ok";
}

beforeEach(() => seed(true));

describe("policy and labels", () => {
  it("classifies the Shopify tools as diagnose with labels; shopify_summary is gone", () => {
    for (const name of NAMES) {
      expect(classify(name), name).toBe("diagnose");
      expect(humanToolLabel(name), name).not.toMatch(/_/);
      expect(humanToolProgressLabel(name), name).toMatch(/^Reading Shopify/);
      expect(getTool(name), name).toBeDefined();
    }
    expect(humanToolLabel("shopify_products")).toBe("Shopify products (live)");
    expect(humanToolLabel("shopify_variants")).toBe("Shopify variants / SKUs (live)");
    expect(humanToolLabel("shopify_sales")).toBe("Shopify sales");
    expect(getTool("shopify_summary")).toBeUndefined();
    expect(classify("shopify_summary")).toBe("blocked");
  });

  it("descriptions say live vs synced and route best sellers to shopify_sales", () => {
    expect(getTool("shopify_products")!.description).toMatch(/live/i);
    expect(getTool("shopify_products")!.description).toContain("shopify_sales");
    expect(getTool("shopify_variants")!.description).toMatch(/live/i);
    expect(getTool("shopify_sales")!.description).toMatch(/synced/i);
    expect(getTool("shopify_sales")!.description).toMatch(/best sell/i);
    expect(getTool("shopify_sales")!.description).toMatch(/synced from orders when a sync runs/);
  });

  it("never promises a nightly sync (the schedule lives outside the repo)", () => {
    expect(buildStaticSystemPromptV2()).not.toMatch(/nightly/i);
    for (const name of NAMES) expect(getTool(name)!.description, name).not.toMatch(/nightly/i);
  });
});

describe("tool set", () => {
  it("omits the Shopify tools when the client has no connection", async () => {
    await seed(false);
    const names = Object.keys(await buildWorkspaceReadToolSetForClient(ctx(CT)));
    for (const n of [...NAMES, "shopify_summary"]) expect(names).not.toContain(n);
    expect(names.sort()).toEqual(Object.keys(buildWorkspaceReadToolSet(ctx(CT))).sort());
  });

  it("includes exactly the three for a connected client, all diagnose class", async () => {
    const names = Object.keys(await buildWorkspaceReadToolSetForClient(ctx(CT)));
    for (const n of NAMES) expect(names).toContain(n);
    expect(names).not.toContain("shopify_summary");
    for (const n of names) expect(classify(n), n).toBe("diagnose");
  });

  it("offers the tools when connected but never synced (live tools still work)", async () => {
    await seed(true, null);
    const names = Object.keys(await buildWorkspaceReadToolSetForClient(ctx(CT)));
    for (const n of NAMES) expect(names).toContain(n);
  });

  it("keeps the base allowlist unchanged", () => {
    for (const n of [...NAMES, "shopify_summary"]) expect(workspaceReadToolNames()).not.toContain(n);
  });

  it("runs through the tool set without the Meta account refusal", async () => {
    const tools = await buildWorkspaceReadToolSetForClient(ctx(CT));
    for (const name of NAMES) {
      const execute = tools[name]!.execute! as (a: unknown, o: unknown) => Promise<Record<string, unknown>>;
      const out = await execute({ limit: 3 }, { toolCallId: "t1", messages: [] });
      expect(out.error, name).toBeUndefined();
      expect(out.rows, name).toBeDefined();
    }
  });
});

describe("live tools", () => {
  it("shopify_products calls the live layer with ctx.clientId and strips client/shop arguments", async () => {
    const out = await call(
      "shopify_products",
      { search: "  oak  ", client_id: TR, clientId: TR, shop_domain: "evil.myshopify.com", shop: "x" },
      CT,
    );
    expect(liveFindProducts).toHaveBeenCalledTimes(1);
    const [clientId, args] = vi.mocked(liveFindProducts).mock.calls[0];
    expect(clientId).toBe(CT);
    expect(args).toEqual({ search: "oak", limit: 10 });
    expect(out.source).toBe("Shopify (live)");
    expect(out.fetched_at).toBeTruthy();
    expect(out.rows?.map((r) => r.title)).toEqual(["Oak Counter Stool"]);
  });

  it("shopify_variants calls the live layer with ctx.clientId", async () => {
    const out = await call("shopify_variants", { sku: "BS-WAL-01", client_id: TR });
    const [clientId, args] = vi.mocked(liveLookupVariants).mock.calls[0];
    expect(clientId).toBe(CT);
    expect(args).toEqual({ sku: "BS-WAL-01", limit: 10 });
    expect(out.rows?.[0]).toMatchObject({ sku: "BS-WAL-01", cost: null, stock: 14 });
  });

  it("validates inputs: limits 1..25, enums, trimmed text up to 200 characters", async () => {
    await expect(call("shopify_products", { limit: 26 })).rejects.toThrow();
    await expect(call("shopify_products", { limit: 0 })).rejects.toThrow();
    await expect(call("shopify_variants", { limit: 26 })).rejects.toThrow();
    await expect(call("shopify_products", { sort_by: "price; drop" })).rejects.toThrow();
    await expect(call("shopify_products", { sort_by: "best_selling" })).rejects.toThrow();
    await expect(call("shopify_products", { status: "active" })).rejects.toThrow();
    await expect(call("shopify_products", { search: "x".repeat(201) })).rejects.toThrow();
    await expect(call("shopify_variants", { sku: "   " })).rejects.toThrow();
    await expect(call("shopify_products", { limit: 25, sort_by: "inventory", status: "DRAFT" })).resolves.toBeDefined();
  });

  it("a live error comes back as { error, source, message } with the fixed text", async () => {
    vi.mocked(liveFindProducts).mockRejectedValueOnce(new LiveShopifyError("RECONNECT"));
    expect(await call("shopify_products", {})).toEqual({
      error: true,
      source: "Shopify",
      message: "Shopify rejected the store's access token. Reconnect the store.",
    });
    vi.mocked(liveLookupVariants).mockRejectedValueOnce(new LiveShopifyError("BUSY"));
    expect(await call("shopify_variants", { sku: "A" })).toEqual({
      error: true,
      source: "Shopify",
      message: "Shopify is busy right now. Try again in a minute.",
    });
  });

  it("an unexpected error never leaks its text", async () => {
    vi.mocked(liveFindProducts).mockRejectedValueOnce(new Error('{"errors":"raw body shpat_SECRET"}'));
    const out = await call("shopify_products", {});
    expect(out).toEqual({ error: true, source: "Shopify", message: "The Shopify lookup failed. Try again." });
  });

  it("a client with no store gets the not-connected error (the model can't pick another client)", async () => {
    // Outside demo mode, so the live layer reads the (demo store) connection for real.
    vi.stubEnv("DEMO_MODE", "false");
    resetConfigCache();
    try {
      const out = await call("shopify_products", { client_id: CT }, TR);
      expect(out).toEqual({ error: true, source: "Shopify", message: "No Shopify store is connected for this client." });
      expect(vi.mocked(liveFindProducts).mock.calls[0][0]).toBe(TR);
    } finally {
      vi.unstubAllEnvs();
      resetConfigCache();
    }
  });
});

describe("shopify_sales tool", () => {
  it("returns synced rows with source and synced_ago, client from ctx only", async () => {
    const out = await call("shopify_sales", { group_by: "vendor", client_id: TR, shop_domain: "x" });
    const [clientId, args] = vi.mocked(querySales).mock.calls[0];
    expect(clientId).toBe(CT);
    expect(args).toEqual({ group_by: "vendor", limit: 25 });
    expect(out.source).toBe("Shopify (synced sales)");
    expect(String(out.synced_ago)).toMatch(/ago/);
    expect(out.rows?.map((r) => r.group)).toEqual(["Nordic Woodworks", "Forge & Co", "Loft Living"]);
  });

  it("validates: limit 1..100, enums, window 30 or 60", async () => {
    await expect(call("shopify_sales", { limit: 101 })).rejects.toThrow();
    await expect(call("shopify_sales", { group_by: "sku" })).rejects.toThrow();
    await expect(call("shopify_sales", { sort_by: "margin" })).rejects.toThrow();
    await expect(call("shopify_sales", { window: 90 })).rejects.toThrow();
    await expect(call("shopify_sales", { vendor: "x".repeat(201) })).rejects.toThrow();
    const ok = await call("shopify_sales", { window: 60, limit: 100, sort_by: "revenue", desc: false });
    expect(ok.window).toBe(60);
  });

  it("says never synced rather than returning numbers", async () => {
    await seed(true, null);
    const out = await call("shopify_sales", {});
    expect(out).toMatchObject({ connected: true, synced_at: null });
    expect(String(out.message)).toContain("not synced yet");
  });

  it("a read failure comes back as a fixed-text tool error", async () => {
    vi.mocked(querySales).mockRejectedValueOnce(new Error("relation shopify_sales: permission denied"));
    const out = await call("shopify_sales", {});
    expect(out).toEqual({
      error: true,
      source: "Shopify",
      message: "Couldn't read the synced Shopify sales. Try again.",
    });
  });
});

describe("prompt and context", () => {
  it("system prompt names the three tools, live vs synced, and the rules", () => {
    const p = buildStaticSystemPromptV2();
    for (const n of NAMES) expect(p).toContain(n);
    expect(p).not.toContain("shopify_summary");
    expect(p).toMatch(/`shopify_products` and `shopify_variants` read Shopify live/);
    expect(p).toMatch(/`shopify_sales` reads .*synced from orders when a sync runs \(Sync now or a scheduled run\)/);
    expect(p).toMatch(/quote that age/);
    expect(p).toMatch(/synced_ago/);
    expect(p).toMatch(/fetched_at/);
    expect(p).toMatch(/cross-check/i);
    expect(p).toMatch(/when Shopify and GA4 disagree/i);
    expect(p).toMatch(/never say Shopify data is unavailable/i);
    expect(p).toMatch(/an admin can connect it under Admin → Connections/);
    expect(p).toMatch(/best sell[^.]*`shopify_sales`/i);
  });

  it("system prompt names Shopify as a source and the record for product sales when connected", () => {
    const p = buildStaticSystemPromptV2();
    expect(p).toContain("Name the source of every number: Meta, GA4, Search Console, Google Ads or Shopify");
    expect(p).toContain("When Shopify is connected it is the record for units sold, stock, SKUs, vendors");
    expect(p).not.toMatch(/Prefer GA4 for sales, revenue, orders and products/);
    expect(p).toContain("after product and code discounts, before order-level discounts, shipping and tax");
    expect(p).toContain("**Spend & return**");
  });

  it("context: connected and synced", async () => {
    const ct = await buildClientContext(CT);
    expect(ct).toContain(`- Shopify: ${MOCK_SHOP.name} (${MOCK_SHOP.domain}), catalogue read live, sales synced 3 hours ago`);
    expect(ct).not.toMatch(/SECRET-CIPHERTEXT|access_token/);
  });

  it("context: stale sales are flagged", async () => {
    await seed(true, 80 * 3_600_000);
    expect(await buildClientContext(CT)).toContain(
      `- Shopify: ${MOCK_SHOP.name} (${MOCK_SHOP.domain}), catalogue read live, sales synced 3 days ago (stale: older than 72 hours)`,
    );
  });

  it("context: latest sales sync failed, with the age of the sales shown", async () => {
    const row = getDemoStore().shopifyConnections[0];
    row.last_sync_at = new Date(Date.now() - 30 * 3_600_000).toISOString();
    row.last_sync_status = "error";
    row.last_sync_error = "Shopify is busy, try again in a few minutes";
    expect(await buildClientContext(CT)).toContain(
      `- Shopify: ${MOCK_SHOP.name} (${MOCK_SHOP.domain}), catalogue read live, latest sales sync failed (Shopify is busy, try again in a few minutes); sales are from the last successful sync 30 hours ago`,
    );
  });

  it("context: first sales sync failed", async () => {
    await seed(true, null);
    const row = getDemoStore().shopifyConnections[0];
    row.last_sync_status = "error";
    row.last_sync_error = "Shopify rejected the token: reconnect the store";
    expect(await buildClientContext(CT)).toContain(
      `- Shopify: ${MOCK_SHOP.name} (${MOCK_SHOP.domain}), catalogue read live, latest sales sync failed (Shopify rejected the token: reconnect the store); sales not synced yet`,
    );
  });

  it("context: sales not synced yet", async () => {
    await seed(true, null);
    expect(await buildClientContext(CT)).toContain(
      `- Shopify: ${MOCK_SHOP.name} (${MOCK_SHOP.domain}), catalogue read live, sales not synced yet`,
    );
  });

  it("context: not connected", async () => {
    await seed(false);
    expect(await buildClientContext(CT)).toContain(
      "- Shopify: not connected (an admin can connect it under Admin → Connections)",
    );
  });
});
