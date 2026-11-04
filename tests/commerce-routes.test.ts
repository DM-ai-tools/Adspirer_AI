import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";

vi.mock("@/lib/security/auth", () => ({ getCurrentUser: vi.fn() }));
import { getCurrentUser } from "@/lib/security/auth";

vi.mock("@/lib/approvals/service", () => ({ createPendingApproval: vi.fn() }));
import { createPendingApproval } from "@/lib/approvals/service";

import { DEMO_CATALOG_ID } from "@/lib/meta/catalog/demo";
import type { CatalogFinding } from "@/lib/meta/catalog/findings";

// The fix tests need findings with every fix type, which the demo report does not have, so the
// report can be replaced per test. Ownership and the other routes run on the real demo service.
const reportOverride = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("@/lib/meta/catalog/service", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/meta/catalog/service")>();
  return {
    ...original,
    getCatalogReport: (clientId: string, catalogId: string) =>
      reportOverride.value && catalogId === DEMO_CATALOG_ID
        ? Promise.resolve(reportOverride.value)
        : original.getCatalogReport(clientId, catalogId),
  };
});
import { GET as getCommerce } from "@/app/api/commerce/route";
import { GET as getReport } from "@/app/api/commerce/[catalogId]/route";
import { GET as getProducts } from "@/app/api/commerce/[catalogId]/products/route";
import { POST as postFix } from "@/app/api/commerce/fixes/route";

const clientId = () => getDemoStore().clients[0].id;
const as = (role: "admin" | "operator") => {
  const p = getDemoStore().profiles.find((x) => x.role === role)!;
  vi.mocked(getCurrentUser).mockResolvedValue({ id: p.id, email: p.email, profile: p });
  return p;
};
const ctx = (catalogId: string) => ({ params: Promise.resolve({ catalogId }) });
const get = (path: string) => new Request(`https://app.example.com${path}`);
const post = (body: unknown) =>
  new Request("https://app.example.com/api/commerce/fixes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const finding = (over: Partial<CatalogFinding>): CatalogFinding => ({
  id: "f",
  severity: "high",
  title: "A finding",
  evidence: [],
  productSetIds: [],
  adSetIds: [],
  howToFix: "Do the thing.",
  fix: null,
  ...over,
});

const use = (adSetId: string, adSetName: string, over: { productSetId?: string; effectiveStatus?: string } = {}) => ({
  adSetId,
  adSetName,
  campaignId: "c1",
  accountId: "act_1",
  productSetId: over.productSetId ?? "set_1",
  learningStatus: null,
  effectiveStatus: over.effectiveStatus ?? "ACTIVE",
  catalogId: DEMO_CATALOG_ID,
});

const FINDINGS: CatalogFinding[] = [
  finding({
    id: "set_too_small:set_1",
    title: "Product set is too small",
    productSetIds: ["set_1"],
    adSetIds: ["as_1", "as_2", "as_gone"],
    fix: {
      toolName: "update_product_set_filter",
      args: {
        product_set_id: "set_1",
        product_set_name: "Bestsellers",
        filter: '{"availability":{"eq":"in stock"}}',
        expected_filter: null,
      },
    },
  }),
  finding({
    id: "feed_stale:feed_1",
    title: "Feed has not refreshed",
    adSetIds: ["as_1"],
    fix: { toolName: "request_feed_refresh", args: { feed_id: "feed_1", feed_name: "Daily feed" } },
  }),
  finding({
    id: "adset_starved:as_1",
    title: "Ad set is starved",
    adSetIds: ["as_1"],
    fix: { toolName: "pause_adset", args: { account_id: "act_1", adset_id: "as_1" } },
  }),
  finding({ id: "diagnostics_must_fix", title: "Must-fix issues", fix: null }),
];

function useReport() {
  reportOverride.value = {
    state: "ok",
    snapshot: {},
    findings: FINDINGS,
    learningLinks: [],
    uses: [
      use("as_1", "DPA - Broad"),
      use("as_2", "DPA - Spring"),
      // Same set, paused: still reached by a filter change, and marked.
      use("as_3", "DPA - Old", { effectiveStatus: "PAUSED" }),
      // The same ad set listed twice: named once.
      use("as_1", "DPA - Broad"),
      // Another set in the same catalogue: only a feed refresh reaches it.
      use("as_4", "DPA - Shoes", { productSetId: "set_2" }),
    ],
  };
}

async function allFour(id: string) {
  return [
    await getCommerce(get(`/api/commerce?clientId=${id}`)),
    await getReport(get(`/api/commerce/${DEMO_CATALOG_ID}?clientId=${id}`), ctx(DEMO_CATALOG_ID)),
    await getProducts(get(`/api/commerce/${DEMO_CATALOG_ID}/products?clientId=${id}`), ctx(DEMO_CATALOG_ID)),
    await postFix(post({ clientId: id, catalogId: DEMO_CATALOG_ID, findingId: "x" })),
  ];
}

beforeEach(() => {
  resetConfigCache();
  vi.mocked(getCurrentUser).mockReset();
  reportOverride.value = null;
  vi.mocked(createPendingApproval).mockReset();
  vi.mocked(createPendingApproval).mockResolvedValue({ id: "approval_1" } as never);
});

describe("commerce routes auth", () => {
  it("401 when unauthenticated on all four", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null);
    const results = await allFour(clientId());
    expect(results.map((r) => r.status)).toEqual([401, 401, 401, 401]);
    expect(createPendingApproval).not.toHaveBeenCalled();
  });

  it("403 for a user without access to the client, on all four", async () => {
    as("operator");
    // A client the operator is not assigned to (admins bypass this check, operators do not).
    const results = await allFour("client_the_operator_is_not_assigned_to");
    expect(results.map((r) => r.status)).toEqual([403, 403, 403, 403]);
    expect(createPendingApproval).not.toHaveBeenCalled();
  });

  it("400 when clientId is missing", async () => {
    as("admin");
    expect((await getCommerce(get("/api/commerce"))).status).toBe(400);
    expect((await getReport(get(`/api/commerce/${DEMO_CATALOG_ID}`), ctx(DEMO_CATALOG_ID))).status).toBe(400);
  });
});

describe("commerce read routes", () => {
  it("lists catalogues and returns the report as the service does", async () => {
    as("admin");
    const list = await (await getCommerce(get(`/api/commerce?clientId=${clientId()}`))).json();
    expect(list.data.state).toBe("ok");
    expect(list.data.catalogs.map((c: { id: string }) => c.id)).toContain(DEMO_CATALOG_ID);

    const res = await getReport(get(`/api/commerce/${DEMO_CATALOG_ID}?clientId=${clientId()}`), ctx(DEMO_CATALOG_ID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.state).toBe("ok");
    expect(body.data.findings.length).toBeGreaterThan(0);
  });

  it("another client's catalogue comes back as no_catalog with HTTP 200", async () => {
    as("admin");
    const res = await getReport(get(`/api/commerce/not_my_catalog?clientId=${clientId()}`), ctx("not_my_catalog"));
    expect(res.status).toBe(200);
    expect((await res.json()).data.state).toBe("no_catalog");
    const products = await getProducts(
      get(`/api/commerce/not_my_catalog/products?clientId=${clientId()}`),
      ctx("not_my_catalog"),
    );
    expect(products.status).toBe(200);
    expect((await products.json()).data.state).toBe("no_catalog");
  });

  it("products route filters by issue and rejects unknown issues", async () => {
    as("admin");
    const ok = await getProducts(
      get(`/api/commerce/${DEMO_CATALOG_ID}/products?clientId=${clientId()}&issue=out_of_stock`),
      ctx(DEMO_CATALOG_ID),
    );
    const body = await ok.json();
    expect(body.data.state).toBe("ok");
    expect(body.data.products.length).toBeGreaterThan(0);
    expect(body.data.products.every((p: { availability: string }) => p.availability === "out of stock")).toBe(true);

    const bad = await getProducts(
      get(`/api/commerce/${DEMO_CATALOG_ID}/products?clientId=${clientId()}&issue=everything`),
      ctx(DEMO_CATALOG_ID),
    );
    expect(bad.status).toBe(400);
  });
});

describe("POST /api/commerce/fixes", () => {
  const NOTE = "Ad sets in ad accounts not mapped to this client also use this product set and would change too.";

  it("builds the approval from the server-side finding and ignores client-supplied args", async () => {
    useReport();
    const user = as("admin");
    const res = await postFix(
      post({
        clientId: clientId(),
        catalogId: DEMO_CATALOG_ID,
        findingId: "set_too_small:set_1",
        filter: '{"price":{"gt":0}}',
        args: { product_set_id: "someone_elses_set", filter: "{}" },
        toolName: "pause_adset",
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ approvalId: "approval_1" });

    expect(createPendingApproval).toHaveBeenCalledTimes(1);
    const input = vi.mocked(createPendingApproval).mock.calls[0][0];
    expect(input.clientId).toBe(clientId());
    expect(input.toolName).toBe("update_product_set_filter");
    expect(input.proposedArgs).toEqual({
      product_set_id: "set_1",
      product_set_name: "Bestsellers",
      filter: '{"availability":{"eq":"in stock"}}',
      expected_filter: null,
    });
    expect(input.requestedBy).toBe(user.id);
    expect(input.reuseAcrossTasks).toBe(true);
    // Every ad set selling this set, from the report's uses rather than the finding's list:
    // deduped, paused ones marked, ad sets on other sets left out.
    expect(input.rationale).toBe(
      ["Product set is too small", "Affects ad sets: DPA - Broad, DPA - Spring, DPA - Old (paused)", NOTE].join("\n"),
    );
  });

  it("lists at most 25 ad sets, then counts the rest", async () => {
    useReport();
    (reportOverride.value as { uses: unknown[] }).uses = Array.from({ length: 30 }, (_, i) => use(`as_${i}`, `Set ${i}`));
    as("admin");
    await postFix(post({ clientId: clientId(), catalogId: DEMO_CATALOG_ID, findingId: "set_too_small:set_1" }));
    const line = vi.mocked(createPendingApproval).mock.calls[0][0].rationale!.split("\n")[1];
    expect(line).toContain("Set 24, and 5 more");
    expect(line).not.toContain("Set 25");
  });

  it("feed refresh fixes carry the unmapped-accounts note", async () => {
    useReport();
    as("admin");
    await postFix(post({ clientId: clientId(), catalogId: DEMO_CATALOG_ID, findingId: "feed_stale:feed_1" }));
    const input = vi.mocked(createPendingApproval).mock.calls[0][0];
    expect(input.toolName).toBe("request_feed_refresh");
    expect(input.proposedArgs).toEqual({ feed_id: "feed_1", feed_name: "Daily feed" });
    // A feed refresh reaches every ad set selling from the catalogue, whatever its product set.
    expect(input.rationale).toContain("Affects ad sets: DPA - Broad, DPA - Spring, DPA - Old (paused), DPA - Shoes");
    expect(input.rationale).toContain(NOTE);
  });

  it("pause_adset fixes do not carry the unmapped-accounts note", async () => {
    useReport();
    as("admin");
    await postFix(post({ clientId: clientId(), catalogId: DEMO_CATALOG_ID, findingId: "adset_starved:as_1" }));
    const input = vi.mocked(createPendingApproval).mock.calls[0][0];
    expect(input.toolName).toBe("pause_adset");
    expect(input.proposedArgs).toEqual({ account_id: "act_1", adset_id: "as_1" });
    expect(input.rationale).toContain("Affects ad sets: DPA - Broad");
    expect(input.rationale).not.toContain("DPA - Spring");
    expect(input.rationale).not.toContain(NOTE);
  });

  it("404 for an unknown finding, 400 for a finding with no fix; nothing is queued", async () => {
    useReport();
    as("admin");
    const unknown = await postFix(post({ clientId: clientId(), catalogId: DEMO_CATALOG_ID, findingId: "nope" }));
    expect(unknown.status).toBe(404);

    const res = await postFix(post({ clientId: clientId(), catalogId: DEMO_CATALOG_ID, findingId: "diagnostics_must_fix" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe(
      "This suggestion has no automatic fix; follow the how-to-fix steps.",
    );
    expect(createPendingApproval).not.toHaveBeenCalled();
  });

  it("another client's catalogue returns no_catalog and queues nothing", async () => {
    as("admin");
    const res = await postFix(post({ clientId: clientId(), catalogId: "not_my_catalog", findingId: "x" }));
    expect(res.status).toBe(200);
    expect((await res.json()).data.state).toBe("no_catalog");
    expect(createPendingApproval).not.toHaveBeenCalled();
  });

  it("rejects invalid bodies with 400", async () => {
    as("admin");
    expect((await postFix(post({ clientId: clientId() }))).status).toBe(400);
    expect((await postFix(new Request("https://x/y", { method: "POST", body: "{nope" }))).status).toBe(400);
  });
});
