import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/observability/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/shopify/query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/shopify/query")>();
  return { ...actual, queryProducts: vi.fn(actual.queryProducts) };
});

import { buildWorkspaceReadToolSet, buildWorkspaceReadToolSetForClient, workspaceReadToolNames } from "@/lib/agent/diagnose-tools-ai";
import { buildClientContext } from "@/lib/agent/context-builder";
import { buildStaticSystemPromptV2 } from "@/lib/agent/prompts-v2";
import { getDemoStore } from "@/lib/demo/store";
import { MOCK_SHOP, mockShopifyCatalog } from "@/lib/shopify/mock";
import { queryProducts } from "@/lib/shopify/query";
import { replaceCatalog, saveConnection } from "@/lib/shopify/store";
import { humanToolLabel, humanToolProgressLabel } from "@/lib/tools/display-labels";
import { classify } from "@/lib/tools/policy";
import { invokeTool, type ToolContext } from "@/lib/tools/registry";
import "@/lib/tools/diagnose";

const CT = "client_clicktrends";
const TR = "client_trafficradius";
const NAMES = ["shopify_products", "shopify_variants", "shopify_summary"];
const ctx = (clientId: string): ToolContext => ({ clientId, userId: "user_admin", taskId: "task_x" });
type Result = Record<string, unknown> & { rows?: Array<Record<string, unknown>> };
const call = async (name: string, args: unknown, clientId = CT) => (await invokeTool(name, args, ctx(clientId))) as Result;

async function seed(connected = true, syncedAgoMs: number | null = 3 * 3_600_000) {
  const s = getDemoStore();
  s.shopifyConnections.length = 0;
  s.shopifyCollections.length = 0;
  s.shopifyProducts.length = 0;
  s.shopifyVariants.length = 0;
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
  await replaceCatalog(CT, mockShopifyCatalog(CT));
  const row = s.shopifyConnections.find((c) => c.id === conn.id)!;
  row.last_sync_at = syncedAgoMs === null ? null : new Date(Date.now() - syncedAgoMs).toISOString();
  row.last_sync_status = syncedAgoMs === null ? "never" : "ok";
}

beforeEach(() => seed(true));

describe("policy and labels", () => {
  it("classifies the Shopify tools as diagnose with labels", () => {
    for (const name of NAMES) {
      expect(classify(name), name).toBe("diagnose");
      expect(humanToolLabel(name), name).not.toMatch(/_/);
      expect(humanToolProgressLabel(name), name).toBe("Reading Shopify…");
    }
    expect(humanToolLabel("shopify_products")).toBe("Shopify products");
    expect(humanToolLabel("shopify_variants")).toBe("Shopify variants / SKUs");
    expect(humanToolLabel("shopify_summary")).toBe("Shopify summary");
  });
});

describe("tool set", () => {
  it("omits the Shopify tools when the client has no connection", async () => {
    await seed(false);
    const names = Object.keys(await buildWorkspaceReadToolSetForClient(ctx(CT)));
    for (const n of NAMES) expect(names).not.toContain(n);
    expect(names.sort()).toEqual(Object.keys(buildWorkspaceReadToolSet(ctx(CT))).sort());
  });

  it("includes them for a connected client, all diagnose class", async () => {
    const names = Object.keys(await buildWorkspaceReadToolSetForClient(ctx(CT)));
    for (const n of NAMES) expect(names).toContain(n);
    for (const n of names) expect(classify(n), n).toBe("diagnose");
  });

  it("keeps the base allowlist unchanged", () => {
    for (const n of NAMES) expect(workspaceReadToolNames()).not.toContain(n);
  });

  it("runs through the tool set without the Meta account refusal", async () => {
    const tools = await buildWorkspaceReadToolSetForClient(ctx(CT));
    const execute = tools.shopify_products!.execute! as (a: unknown, o: unknown) => Promise<Record<string, unknown>>;
    const out = await execute({ limit: 3 }, { toolCallId: "t1", messages: [] });
    expect(out.error).toBeUndefined();
    expect(out.rows).toBeDefined();
  });
});

describe("shopify tools", () => {
  it("shopify_products returns rows with synced_ago", async () => {
    const out = await call("shopify_products", { sort_by: "revenue_30d", limit: 5 });
    expect(out.rows?.length).toBeGreaterThan(0);
    expect(out.rows!.length).toBeLessThanOrEqual(5);
    expect(String(out.synced_ago)).toMatch(/ago/);
  });

  it("shopify_variants and shopify_summary answer", async () => {
    const v = await call("shopify_variants", { sort_by: "stock", desc: false, limit: 3 });
    expect(v.rows?.length).toBeGreaterThan(0);
    const s = await call("shopify_summary", { group_by: "vendor" });
    expect(s.rows?.length).toBeGreaterThan(0);
    expect(s.synced_ago).toBeDefined();
  });

  it("rejects limit 500 and bad enums", async () => {
    await expect(call("shopify_products", { limit: 500 })).rejects.toThrow();
    await expect(call("shopify_variants", { limit: 0 })).rejects.toThrow();
    await expect(call("shopify_products", { sort_by: "price; drop" })).rejects.toThrow();
    await expect(call("shopify_products", { status: "active" })).rejects.toThrow();
    await expect(call("shopify_summary", { group_by: "sku" })).rejects.toThrow();
    await expect(call("shopify_products", { search: "x".repeat(201) })).rejects.toThrow();
  });

  it("never takes a client id from the model", async () => {
    await seed(false);
    const out = await call("shopify_products", { client_id: CT }, TR);
    expect(out).toMatchObject({ connected: false });
  });

  it("turns a thrown query error into a tool error", async () => {
    vi.mocked(queryProducts).mockRejectedValueOnce(new Error("db down"));
    const out = await call("shopify_products", {});
    expect(out).toMatchObject({ error: true, source: "Shopify", message: "db down" });
  });

  it("says never synced rather than returning numbers", async () => {
    await seed(true, null);
    const out = await call("shopify_products", {});
    expect(out).toMatchObject({ connected: true, synced_at: null });
  });
});

describe("prompt and context", () => {
  it("system prompt names the Shopify tools and rules", () => {
    const p = buildStaticSystemPromptV2();
    for (const n of NAMES) expect(p).toContain(n);
    expect(p).toMatch(/synced_ago/);
    expect(p).toMatch(/cross-check/i);
    expect(p).toMatch(/never say Shopify data is unavailable/i);
    expect(p).toMatch(/Admin → Connections/);
  });

  it("context says when Shopify is connected, with no secrets", async () => {
    const ct = await buildClientContext(CT);
    expect(ct).toContain(`- Shopify: ${MOCK_SHOP.name} (${MOCK_SHOP.domain}), last synced 3 hours ago`);
    expect(ct).not.toMatch(/SECRET-CIPHERTEXT|access_token/);
  });

  it("context says never synced", async () => {
    await seed(true, null);
    expect(await buildClientContext(CT)).toMatch(/Shopify: .*never synced/);
  });

  it("context says not connected", async () => {
    await seed(false);
    expect(await buildClientContext(CT)).toMatch(/Shopify: not connected/);
  });
});
