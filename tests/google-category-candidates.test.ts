import { afterEach, describe, expect, it, vi } from "vitest";
import { gatherDiagnoseEvidence, runAdspirerAgent } from "@/lib/agent/adspirer-agent";
import { createTask } from "@/lib/agent/task-runner";
import {
  googleCandidateFacts,
  googleCandidateServiceBody,
  googleImportUnavailableMessage,
} from "@/lib/clients/category-form";
import { getDemoStore } from "@/lib/demo/store";
import { googleCategoryCandidates } from "@/lib/google/category-candidates";
import { getMockGoogleDataProvider } from "@/lib/google/mock-provider";
import { GoogleReconnectRequired } from "@/lib/google/oauth";
import { getGoogleDataProvider, type GoogleDataProvider } from "@/lib/google/provider";
import type { Ga4CategoryRevenue, Ga4LandingPages, SearchDemand } from "@/lib/google/types";
import { scanSiteCandidates } from "@/lib/scraping/site-scan";
import { resetSiteScanCache, sameCategoryName } from "@/lib/strategy/requested-category";
import type { ClientService } from "@/types";

vi.mock("@/lib/google/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/google/provider")>();
  return { ...actual, getGoogleDataProvider: vi.fn(actual.getGoogleDataProvider) };
});
// The website scan is slow and external; every chat test here says what it returns.
vi.mock("@/lib/scraping/site-scan", () => ({ scanSiteCandidates: vi.fn() }));
vi.mock("@/lib/security/auth", () => ({ getCurrentUser: vi.fn() }));
import { getCurrentUser } from "@/lib/security/auth";

const CT = "client_clicktrends";
const SITE = "https://clicktrends.example";
const PAGE = (slug: string) => `${SITE}/collections/${slug}`;

const GA4: Ga4CategoryRevenue = {
  method: "item",
  currency: "AUD",
  rows: [
    { key: "Bar Stool", revenueCents: 1_230_000, purchases: 60 },
    { key: "Dining Chairs", revenueCents: 300_000, purchases: 10 },
    { key: "(not set)", revenueCents: 90_000, purchases: 3 },
    { key: "Gift Cards", revenueCents: 50_000, purchases: 5 },
    { key: "All", revenueCents: 40_000, purchases: 4 },
    { key: "", revenueCents: 10_000, purchases: 1 },
  ],
  byChannel: [],
};
const LANDING: Ga4LandingPages = {
  currency: "AUD",
  rows: [
    { path: "/collections/bar-stools", revenueCents: 1_000_000, purchases: 50 },
    // A product page under the collection counts toward the collection.
    { path: "/collections/bar-stools/products/oak-stool", revenueCents: 100_000, purchases: 5 },
    { path: "/collections/outdoor-sofas", revenueCents: 40_000, purchases: 2 },
    { path: "/collections/gift-card", revenueCents: 20_000, purchases: 2 },
    { path: "/collections/sale", revenueCents: 20_000, purchases: 2 },
    { path: "/", revenueCents: 500_000, purchases: 20 },
  ],
};
const GSC: SearchDemand = {
  siteUrl: `${SITE}/`,
  rows: [
    {
      page: "https://www.clicktrends.example/collections/bar-stools",
      clicks: 900, impressions: 20_000, position: 6,
      topQueries: ["bar stools", "counter stools", "swivel stools", "backless stools"],
    },
    { page: `${SITE}/collections/lamps`, clicks: 120, impressions: 4_000, position: 9, topQueries: ["lamps"] },
    { page: `${SITE}/collections/rugs`, clicks: 0, impressions: 300, position: 30, topQueries: [] },
    { page: `${SITE}/blogs/news/how-to-pick-a-stool`, clicks: 500, impressions: 9_000, position: 4, topQueries: ["stool height"] },
  ],
};

function override(patch: Partial<GoogleDataProvider> = {}) {
  const provider: GoogleDataProvider = {
    ...getMockGoogleDataProvider(),
    ga4CategoryRevenue: async () => structuredClone(GA4),
    ga4LandingPages: async () => structuredClone(LANDING),
    searchDemand: async () => structuredClone(GSC),
    ...patch,
  };
  vi.mocked(getGoogleDataProvider).mockReturnValue(provider);
  return provider;
}

function service(name: string, landing: string | null): ClientService {
  return {
    id: `svc_${name}`, client_id: CT, name, description: null, keywords: null, landing_page_url: landing,
    priority: 0, is_active: true, gross_margin_pct: null, average_order_value_cents: null, url_patterns: null,
    source: "manual", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  };
}

const unmap = (...kinds: string[]) => {
  for (const a of getDemoStore().googleAssets) if (kinds.includes(a.kind)) a.mapped_client_id = null;
};

const run = (existing: ClientService[] = [], websiteUrl: string | null = SITE) =>
  googleCategoryCandidates({ clientId: CT, existing, websiteUrl });

afterEach(() => {
  vi.mocked(getGoogleDataProvider).mockReset();
  vi.mocked(scanSiteCandidates).mockReset();
  resetSiteScanCache();
  vi.restoreAllMocks();
});

describe("sameCategoryName", () => {
  it("is case-insensitive and plural-tolerant, both ways, whole name only", () => {
    expect(sameCategoryName("Bar Stool", "bar stools")).toBe(true);
    expect(sameCategoryName("Bar Stools", "Bar Stool")).toBe(true);
    expect(sameCategoryName("Accessories", "accessory")).toBe(true);
    expect(sameCategoryName("Bar Stools", "Black Bar Stools")).toBe(false);
    expect(sameCategoryName("Stools", "Bar Stools")).toBe(false);
  });
});

describe("googleCategoryCandidates", () => {
  it("joins GA4 item categories to their pages, keeps unmatched ones and slug-only pages, drops junk", async () => {
    override();
    const out = await run();
    expect(out.source).toBe("google");
    if (out.source !== "google") return;
    expect(out.currency).toBe("AUD");
    expect(out.warnings).toEqual([]);
    expect(out.candidates.map((c) => c.name)).toEqual(["Bar Stool", "Dining Chairs", "Outdoor Sofas", "Lamps"]);
    const [bar, chairs, sofas, lamps] = out.candidates;
    expect(bar).toEqual({
      name: "Bar Stool",
      landing_page_url: PAGE("bar-stools"),
      alreadyAdded: false,
      revenueCents: 1_230_000,
      purchases: 60,
      gscClicks: 900,
      topQueries: ["bar stools", "counter stools", "swivel stools"],
      // The page's own order value: 1,100,000 / 55 purchases.
      average_order_value_cents: 20_000,
      aovEstimated: false,
      priority: 4,
      preselect: true,
    });
    expect(chairs).toMatchObject({
      landing_page_url: null, revenueCents: 300_000, purchases: 10, gscClicks: 0, topQueries: [],
      average_order_value_cents: 30_000, aovEstimated: true, priority: 3, preselect: true,
    });
    // Fewer than 3 page purchases and no item category: no order value.
    expect(sofas).toMatchObject({
      landing_page_url: PAGE("outdoor-sofas"), revenueCents: 40_000, purchases: 2,
      average_order_value_cents: null, aovEstimated: false, priority: 2, preselect: true,
    });
    // Search Console only: a candidate, but not ticked.
    expect(lamps).toMatchObject({
      landing_page_url: PAGE("lamps"), revenueCents: 0, gscClicks: 120, topQueries: ["lamps"],
      average_order_value_cents: null, priority: 1, preselect: false,
    });
  });

  it("reads an 'A > B' item category by its segments", async () => {
    override({
      ga4CategoryRevenue: async () => ({
        ...structuredClone(GA4),
        rows: [
          { key: "Furniture > Bar Stools", revenueCents: 500_000, purchases: 20 },
          { key: "Furniture > Ottomans", revenueCents: 100_000, purchases: 4 },
        ],
      }),
    });
    const out = await run();
    if (out.source !== "google") throw new Error("expected google");
    expect(out.candidates.slice(0, 2)).toMatchObject([
      { name: "Bar Stools", landing_page_url: PAGE("bar-stools"), revenueCents: 500_000 },
      { name: "Ottomans", landing_page_url: null, revenueCents: 100_000 },
    ]);
  });

  it("estimates the order value from items when the page has fewer than 3 purchases", async () => {
    override({
      ga4LandingPages: async () => ({ currency: "AUD", rows: [{ path: "/collections/bar-stools", revenueCents: 30_000, purchases: 2 }] }),
    });
    const out = await run();
    if (out.source !== "google") throw new Error("expected google");
    expect(out.candidates[0]).toMatchObject({ name: "Bar Stool", average_order_value_cents: 20_500, aovEstimated: true });
  });

  it("marks what's already added by page or by name and doesn't preselect it", async () => {
    override();
    const out = await run([
      service("Bar stools", PAGE("bar-stools")),
      service("Dining Chair", null),
      service("Patio", PAGE("outdoor-sofas/")),
    ]);
    if (out.source !== "google") throw new Error("expected google");
    const by = Object.fromEntries(out.candidates.map((c) => [c.name, c]));
    expect(by["Bar Stool"]).toMatchObject({ alreadyAdded: true, preselect: false });
    expect(by["Dining Chairs"]).toMatchObject({ alreadyAdded: true, preselect: false });
    expect(by["Outdoor Sofas"]).toMatchObject({ alreadyAdded: true, preselect: false });
    expect(by["Lamps"]).toMatchObject({ alreadyAdded: false });
  });

  it("reads GA4 for the last 90 days", async () => {
    const ranges: Array<{ since: string; until: string }> = [];
    override({ ga4CategoryRevenue: async (_id, range) => { ranges.push(range); return structuredClone(GA4); } });
    await run();
    const [{ since, until }] = ranges;
    expect(since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((Date.parse(until) - Date.parse(since)) / 86_400_000).toBe(89);
  });

  it("makes GA4 paths absolute with an sc-domain site when the client has no website", async () => {
    const gsc = getDemoStore().googleAssets.find((a) => a.kind === "gsc_site")!;
    gsc.external_id = "sc-domain:clicktrends.example";
    override({ searchDemand: async (siteUrl) => ({ siteUrl, rows: [] }) });
    const out = await run([], null);
    if (out.source !== "google") throw new Error("expected google");
    expect(out.candidates[0]).toMatchObject({ name: "Bar Stool", landing_page_url: PAGE("bar-stools") });
  });

  it("is not_mapped without a GA4 property or Search Console site", async () => {
    unmap("ga4_property", "gsc_site");
    override();
    expect(await run()).toEqual({ source: "unavailable", reason: "not_mapped", candidates: [] });
  });

  it("asks to reconnect when Google needs reconnecting", async () => {
    override({ searchDemand: async () => { throw new GoogleReconnectRequired(); } });
    expect(await run()).toEqual({ source: "unavailable", reason: "reconnect", candidates: [] });
  });

  it("keeps GA4 when Search Console fails, with a warning", async () => {
    override({ searchDemand: async () => { throw new Error("denied"); } });
    const out = await run();
    if (out.source !== "google") throw new Error("expected google");
    expect(out.warnings).toEqual(["Search Console: denied"]);
    expect(out.candidates.map((c) => c.name)).toEqual(["Bar Stool", "Dining Chairs", "Outdoor Sofas"]);
    expect(out.candidates[0].gscClicks).toBe(0);
  });

  it("is failed when every part fails, logging only the message", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    override({
      ga4CategoryRevenue: async () => { throw new Error("ga4 down"); },
      ga4LandingPages: async () => { throw new Error("ga4 down"); },
      searchDemand: async () => { throw new Error("gsc down"); },
    });
    expect(await run()).toEqual({ source: "unavailable", reason: "failed", candidates: [] });
    expect(warn.mock.calls.map((c) => String(c[0])).some((l) => l.includes("gsc down"))).toBe(true);
  });

  it("works on the demo mock data", async () => {
    const out = await run();
    if (out.source !== "google") throw new Error("expected google");
    expect(out.candidates.map((c) => c.name)).toEqual(["Bar Stools", "Sofas"]);
    expect(out.candidates.every((c) => c.landing_page_url?.startsWith(SITE))).toBe(true);
  });
});

describe("Import from Google panel text", () => {
  it("says why Google couldn't be read", () => {
    expect(googleImportUnavailableMessage("not_mapped")).toBe(
      "Map a GA4 property or Search Console site to this client under Admin → Connections.",
    );
    expect(googleImportUnavailableMessage("reconnect")).toBe("Google needs reconnecting under Admin → Connections.");
    expect(googleImportUnavailableMessage("failed")).toBe("Couldn't read Google right now; try again.");
  });

  it("shows revenue, clicks and order value per row, with est. for an estimate", () => {
    const row = { revenueCents: 1_230_000, gscClicks: 900, average_order_value_cents: 20_550, aovEstimated: true };
    expect(googleCandidateFacts(row, "AUD")).toEqual(["A$12,300 revenue, last 90 days", "900 search clicks", "A$205.50 order value est."]);
    expect(googleCandidateFacts({ ...row, revenueCents: 0, gscClicks: 1, average_order_value_cents: null }, null)).toEqual([
      "1 search click",
    ]);
    expect(googleCandidateFacts({ ...row, aovEstimated: false }, "AUD")[2]).toBe("A$205.50 order value");
  });

  it("posts the candidate as an import", () => {
    expect(
      googleCandidateServiceBody({
        name: "Bar Stools", landing_page_url: PAGE("bar-stools"), alreadyAdded: false, revenueCents: 1, purchases: 1,
        gscClicks: 0, topQueries: [], average_order_value_cents: 20_000, aovEstimated: false, priority: 4, preselect: true,
      }),
    ).toEqual({
      name: "Bar Stools", landing_page_url: PAGE("bar-stools"), average_order_value_cents: 20_000, priority: 4, source: "import",
    });
  });
});

describe("GET /api/clients/:id/services/google-candidates", () => {
  const call = async (signedIn: boolean) => {
    const p = getDemoStore().profiles.find((x) => x.role === "operator")!;
    vi.mocked(getCurrentUser).mockResolvedValue(signedIn ? { id: p.id, email: p.email, profile: p } : null);
    const { GET } = await import("@/app/api/clients/[id]/services/google-candidates/route");
    return GET(new Request("http://app.test/x"), { params: Promise.resolve({ id: CT }) });
  };

  it("returns the client's Google candidates", async () => {
    override();
    const res = await call(true);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { source: string; candidates: Array<{ name: string; alreadyAdded: boolean }> } };
    expect(body.data.source).toBe("google");
    // The demo client already has Bar stools on that page.
    expect(body.data.candidates.find((c) => c.name === "Bar Stool")?.alreadyAdded).toBe(true);
  });

  it("needs a signed-in user", async () => {
    override();
    const res = await call(false);
    expect(res.status).toBe(401);
  });
});

describe("chat: Google before the website scan (DEMO_MODE)", () => {
  const ASK = "How do we spend $4k and get $40k back on bar stools using Google Ads and Meta together?";
  const GA4_LINE =
    `Added **Bar Stools** (${PAGE("bar-stools")}) as a category for ClickTrends, from GA4 (A$12,300 revenue, last 90 days). ` +
    `Set its margin on the Services tab, or tell me ("bar stools margin is 45%"), for sharper targets.`;
  const ctServices = () => getDemoStore().clientServices.filter((s) => s.client_id === CT);
  const noCategories = () => {
    const store = getDemoStore();
    store.clientServices = store.clientServices.filter((s) => s.client_id !== CT);
  };
  const ga4 = (key: string, revenueCents: number): GoogleDataProvider["ga4CategoryRevenue"] =>
    async () => ({ ...structuredClone(GA4), rows: [{ key, revenueCents, purchases: 60 }] });

  it("adds a Google match with the GA4 notice and never scans", async () => {
    noCategories();
    override({ ga4CategoryRevenue: ga4("Bar Stools", 1_230_000) });
    const gathered = await gatherDiagnoseEvidence({ clientId: CT, request: ASK, intent: "strategy" });
    expect(ctServices()).toHaveLength(1);
    expect(ctServices()[0]).toMatchObject({
      name: "Bar Stools",
      landing_page_url: PAGE("bar-stools"),
      average_order_value_cents: 20_000,
      source: "import",
      is_active: true,
    });
    expect(gathered.evidence).toContain(GA4_LINE);
    expect(scanSiteCandidates).not.toHaveBeenCalled();

    const task = await createTask({ clientId: CT, createdBy: "profile_operator_demo", title: ASK, goal: ASK });
    const result = await runAdspirerAgent({ task, clientContext: "", toolEvidence: gathered.evidence, intent: "strategy" });
    expect(result.summary.startsWith(GA4_LINE)).toBe(true);
  });

  it("says Search Console when the match has no revenue", async () => {
    noCategories();
    override({ ga4CategoryRevenue: async () => ({ ...structuredClone(GA4), rows: [] }), ga4LandingPages: async () => ({ currency: "AUD", rows: [] }) });
    const gathered = await gatherDiagnoseEvidence({ clientId: CT, request: ASK, intent: "strategy" });
    // Only Search Console knows the page, so its URL is the one Search Console reports.
    expect(gathered.evidence).toContain(
      "Added **Bar Stools** (https://www.clicktrends.example/collections/bar-stools) as a category for ClickTrends, from Search Console. Set its margin",
    );
    expect(scanSiteCandidates).not.toHaveBeenCalled();
  });

  it("falls back to the website scan when Google isn't mapped", async () => {
    noCategories();
    unmap("ga4_property", "gsc_site");
    override();
    vi.mocked(scanSiteCandidates).mockResolvedValue({
      candidates: [{ name: "Bar Stools", landing_page_url: PAGE("bar-stools"), alreadyAdded: false }],
      source: "firecrawl",
    });
    const gathered = await gatherDiagnoseEvidence({ clientId: CT, request: ASK, intent: "strategy" });
    expect(scanSiteCandidates).toHaveBeenCalledTimes(1);
    expect(ctServices()[0]).toMatchObject({ name: "Bar Stools", source: "site_scan" });
    expect(gathered.evidence).toContain(`Added **Bar Stools** (${PAGE("bar-stools")}) as a category for ClickTrends. Set its margin`);
  });

  it("falls back to the scan when Google has no match, and reads Google once per day", async () => {
    noCategories();
    const provider = override({ ga4CategoryRevenue: ga4("Sofas", 100_000), ga4LandingPages: async () => ({ currency: "AUD", rows: [] }), searchDemand: async (siteUrl) => ({ siteUrl, rows: [] }) });
    // Only the category candidates read landing pages (the channel snapshot reads GA4 too).
    const spy = vi.spyOn(provider, "ga4LandingPages");
    vi.mocked(scanSiteCandidates).mockResolvedValue({ candidates: [], source: "firecrawl" });
    await gatherDiagnoseEvidence({ clientId: CT, request: ASK, intent: "strategy" });
    const gathered = await gatherDiagnoseEvidence({ clientId: CT, request: ASK, intent: "strategy" });
    expect(scanSiteCandidates).toHaveBeenCalled();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(ctServices()).toEqual([]);
    expect(gathered.evidence).toContain(`Couldn't find "bar stools" on ${SITE}; add it on the Services tab.`);
  });
});
