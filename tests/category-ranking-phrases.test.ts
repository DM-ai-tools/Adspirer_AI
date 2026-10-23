import { afterEach, describe, expect, it, vi } from "vitest";
import { getDemoStore } from "@/lib/demo/store";
import { googleCategoryCandidates } from "@/lib/google/category-candidates";
import { getMockGoogleDataProvider } from "@/lib/google/mock-provider";
import { getGoogleDataProvider, type GoogleDataProvider } from "@/lib/google/provider";
import { scanSiteCandidates } from "@/lib/scraping/site-scan";
import {
  addCategoryFromRequest,
  GENERIC_COLLECTIONS,
  isRankingPhrase,
  requestedCategoryPhrase,
  resetSiteScanCache,
} from "@/lib/strategy/requested-category";

vi.mock("@/lib/google/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/google/provider")>();
  return { ...actual, getGoogleDataProvider: vi.fn(actual.getGoogleDataProvider) };
});
// The website scan is slow and external; every test here says what it returns.
vi.mock("@/lib/scraping/site-scan", () => ({ scanSiteCandidates: vi.fn() }));

const CT = "client_clicktrends";
const SITE = "https://clicktrends.example";

afterEach(() => {
  vi.mocked(getGoogleDataProvider).mockReset();
  vi.mocked(scanSiteCandidates).mockReset();
  resetSiteScanCache();
  vi.restoreAllMocks();
});

/** ClickTrends with no categories and no Google mapping, so a named category goes to the scan. */
function noCategories() {
  const store = getDemoStore();
  store.clientServices = store.clientServices.filter((s) => s.client_id !== CT);
  for (const asset of store.googleAssets) if (asset.mapped_client_id === CT) asset.mapped_client_id = null;
  vi.mocked(scanSiteCandidates).mockResolvedValue({
    source: "firecrawl",
    candidates: [
      { name: "Bar Stools", landing_page_url: `${SITE}/collections/bar-stools`, alreadyAdded: false },
      { name: "Best Selling Products", landing_page_url: `${SITE}/collections/best-selling-products`, alreadyAdded: false },
    ],
  });
}

const ctServices = () => getDemoStore().clientServices.filter((s) => s.client_id === CT);

describe("ranking phrases are never categories", () => {
  it("recognises superlatives and rankings", () => {
    for (const phrase of [
      "best selling product",
      "best selling products",
      "best-selling products",
      "top 10 products",
      "top products",
      "best sellers",
      "bestsellers",
      "most popular items",
      "worst performing ads",
      "highest ROAS products",
      "lowest converting products",
      "biggest sellers",
      "leading products",
      "popular",
      "trending",
      "top",
    ]) {
      expect(isRankingPhrase(phrase), phrase).toBe(true);
    }
  });

  it("leaves real category names alone", () => {
    for (const phrase of ["bar stools", "top hats", "tops", "bestway pools", "outdoor sofas", "mostly linen"]) {
      expect(isRankingPhrase(phrase), phrase).toBe(false);
    }
  });

  it("reads no category from a ranking ask", () => {
    expect(
      requestedCategoryPhrase("how much have we spent on the best selling product in the last 30 days", "spend"),
    ).toBeNull();
    expect(requestedCategoryPhrase("spend on top products", "spend")).toBeNull();
    expect(requestedCategoryPhrase("What have we spent on our best sellers?", "spend")).toBeNull();
    expect(requestedCategoryPhrase("Build a 10x plan for the top 5 products", "strategy")).toBeNull();
    expect(requestedCategoryPhrase("spend on bar stools", "spend")).toBe("bar stools");
  });

  it("adds nothing and doesn't scan for a ranking ask", async () => {
    noCategories();
    for (const request of [
      "how much have we spent on the best selling product in the last 30 days",
      "spend on top products",
    ]) {
      const out = await addCategoryFromRequest({ clientId: CT, request, kind: "spend", active: [] });
      expect(out.evidence, request).toBeUndefined();
      expect(out.services).toEqual([]);
    }
    expect(scanSiteCandidates).not.toHaveBeenCalled();
    expect(ctServices()).toEqual([]);
  });

  it("still adds Bar Stools from 'spend on bar stools'", async () => {
    noCategories();
    const out = await addCategoryFromRequest({ clientId: CT, request: "spend on bar stools", kind: "spend", active: [] });
    expect(out.scoped?.name).toBe("Bar Stools");
    expect(ctServices().map((s) => s.name)).toEqual(["Bar Stools"]);
  });
});

describe("generic collections", () => {
  it("includes best sellers, trending, featured and the other catch-alls", () => {
    for (const name of [
      "best selling products",
      "best-selling-products",
      "bestsellers",
      "best sellers",
      "trending",
      "featured",
      "popular",
      "new in",
      "clearance",
      "collections",
      "all",
    ]) {
      expect(GENERIC_COLLECTIONS.has(name), name).toBe(true);
    }
  });

  it("Import from Google no longer lists Best Selling Products", async () => {
    const base = getMockGoogleDataProvider();
    const provider: GoogleDataProvider = {
      ...base,
      ga4LandingPages: async (id, range) => {
        const out = await base.ga4LandingPages(id, range);
        out.rows.push(
          { path: "/collections/best-selling-products", revenueCents: 900_000, purchases: 40 },
          { path: "/collections/trending", revenueCents: 50_000, purchases: 3 },
          { path: "/collections/top-sellers", revenueCents: 40_000, purchases: 2 },
        );
        return out;
      },
    };
    vi.mocked(getGoogleDataProvider).mockReturnValue(provider);
    const out = await googleCategoryCandidates({ clientId: CT, existing: [], websiteUrl: SITE });
    expect(out.source).toBe("google");
    const names = out.candidates.map((c) => c.name);
    expect(names).toContain("Bar Stools");
    expect(names).not.toContain("Best Selling Products");
    expect(names).not.toContain("Trending");
    expect(names).not.toContain("Top Sellers");
  });
});
