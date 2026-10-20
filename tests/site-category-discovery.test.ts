import { afterEach, describe, expect, it, vi } from "vitest";
import { getDemoStore } from "@/lib/demo/store";
import { resetConfigCache } from "@/lib/config";
import { discoverCategoryCandidates, fetchCategorySitemapUrls, matchServicePages } from "@/lib/scraping/site-map";
import type { ClientService } from "@/types";

vi.mock("@/lib/security/auth", () => ({ getCurrentUser: vi.fn() }));
import { getCurrentUser } from "@/lib/security/auth";
// The service-name fallback reads the homepage with the existing scraper.
vi.mock("@/lib/scraping/firecrawl", () => ({
  scrapeWebsiteServices: vi.fn().mockResolvedValue({ url: "", services: [], source: "firecrawl" }),
}));
import { scrapeWebsiteServices } from "@/lib/scraping/firecrawl";
// Route tests don't read real sitemaps; the sitemap reader has its own tests below.
vi.mock("@/lib/scraping/site-map", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/scraping/site-map")>();
  return { ...actual, fetchCategorySitemapUrls: vi.fn().mockResolvedValue([]) };
});

const SITE = "https://shop.example";
const svc = (landing: string | null): ClientService =>
  ({ id: "s1", client_id: "c", name: "x", landing_page_url: landing }) as ClientService;

describe("discoverCategoryCandidates", () => {
  it("proposes collection and category pages, dedupes, excludes non-category and other hosts", () => {
    const out = discoverCategoryCandidates(
      [
        `${SITE}/collections/bar-stools`,
        `${SITE}/collections/bar-stools?page=2`,
        `${SITE}/product-category/dining-chairs/`,
        `${SITE}/products/oak-stool`,
        `${SITE}/blogs/news/x`,
        `${SITE}/cart`,
        "https://other.example/collections/sofas",
      ],
      SITE,
      [],
    );
    expect(out.map((c) => c.name)).toEqual(["Bar Stools", "Dining Chairs"]);
    expect(out[0].landing_page_url).toBe(`${SITE}/collections/bar-stools`);
    expect(out.every((c) => !c.alreadyAdded)).toBe(true);
  });

  it("treats www. and a port as the same host as the site", () => {
    const out = discoverCategoryCandidates(
      ["https://www.shop.example/collections/bar-stools", "https://shop.example:443/collections/sofas"],
      SITE,
      [],
    );
    expect(out.map((c) => c.landing_page_url)).toEqual([
      "https://www.shop.example/collections/bar-stools",
      "https://shop.example/collections/sofas",
    ]);
  });

  it("skips past a malformed % URL instead of failing the scan", () => {
    const out = discoverCategoryCandidates(
      [`${SITE}/collections/100%-wool`, `${SITE}/collections/bar-stools`, `${SITE}/collections/caf%C3%A9-chairs`],
      SITE,
      [],
    );
    expect(out.map((c) => c.name)).toEqual(expect.arrayContaining(["Bar Stools", "Café Chairs"]));
  });

  it("collapses nested product and pagination URLs to the category URL", () => {
    const out = discoverCategoryCandidates(
      [
        `${SITE}/collections/bar-stools`,
        `${SITE}/collections/bar-stools/products/oak-stool`,
        `${SITE}/collections/bar-stools/page/2`,
      ],
      SITE,
      [svc(`${SITE}/collections/bar-stools`)],
    );
    expect(out).toEqual([
      { name: "Bar Stools", landing_page_url: `${SITE}/collections/bar-stools`, alreadyAdded: true },
    ]);
  });

  it("flags candidates already added, ignoring host, case, slash and query", () => {
    const out = discoverCategoryCandidates(
      [`${SITE}/collections/bar-stools`, `${SITE}/collections/sofas`],
      SITE,
      [svc("https://www.other.example/Collections/Bar-Stools/?utm=1")],
    );
    expect(out.find((c) => c.name === "Bar Stools")?.alreadyAdded).toBe(true);
    expect(out.find((c) => c.name === "Sofas")?.alreadyAdded).toBe(false);
  });

  it("keeps a large store's whole catalogue (duringdays.com.au has 2,451 collections), capped at 5000", () => {
    const store = discoverCategoryCandidates(
      Array.from({ length: 2451 }, (_, i) => `${SITE}/collections/cat-${i}`),
      SITE,
      [],
    );
    expect(store).toHaveLength(2451);
    const urls = Array.from({ length: 5200 }, (_, i) => `${SITE}/collections/cat-${i}`);
    const out = discoverCategoryCandidates(urls, SITE, []);
    expect(out).toHaveLength(5000);
    const names = out.map((c) => c.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });
});

describe("GET /api/clients/:id/services/discover", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetConfigCache();
  });
  const call = async () => {
    const p = getDemoStore().profiles.find((x) => x.role === "operator")!;
    vi.mocked(getCurrentUser).mockResolvedValue({ id: p.id, email: p.email, profile: p });
    const { GET } = await import("@/app/api/clients/[id]/services/discover/route");
    const res = await GET(new Request("http://app.test/x"), {
      params: Promise.resolve({ id: "client_modern_dental" }),
    });
    return (await res.json()) as { data: { candidates: unknown[]; source: string } };
  };

  it("is unavailable without FIRECRAWL_API_KEY", async () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "");
    resetConfigCache();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { data } = await call();
    expect(data).toEqual({ candidates: [], source: "unavailable", reason: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says the client has no website instead of blaming the crawler", async () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "fc-test");
    resetConfigCache();
    getDemoStore().clients.find((c) => c.id === "client_modern_dental")!.website_url = null;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { data } = await call();
    expect(data).toEqual({ candidates: [], source: "unavailable", reason: "no_website" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is unavailable when the map call fails", async () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "fc-test");
    resetConfigCache();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 500 })));
    const { data } = await call();
    expect(data).toEqual({ candidates: [], source: "unavailable", reason: "scan_failed" });
  });

  it("is unavailable when fetch throws", async () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "fc-test");
    resetConfigCache();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { data } = await call();
    expect(data).toEqual({ candidates: [], source: "unavailable", reason: "scan_failed" });
    // The failure is logged, not swallowed.
    expect(warn.mock.calls.map((c) => String(c[0])).some((line) => line.includes("network"))).toBe(true);
    warn.mockRestore();
  });

  it("falls back to the site's service names when it has no category pages", async () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "fc-test");
    resetConfigCache();
    const site = getDemoStore().clients.find((c) => c.id === "client_modern_dental")!.website_url!;
    const origin = new URL(site).origin;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({ success: true, links: [`${origin}/dental-implants`, `${origin}/dental-implants-cost-guide`, `${origin}/blog`] }),
      ),
    );
    vi.mocked(scrapeWebsiteServices).mockResolvedValueOnce({
      url: site,
      services: [
        { id: "1", name: "Dental Implants" },
        { id: "2", name: "Teeth Whitening" },
      ],
      source: "firecrawl",
    });
    const { data } = await call();
    expect(data.source).toBe("firecrawl");
    expect(data.candidates).toEqual([
      { name: "Dental Implants", landing_page_url: `${origin}/dental-implants`, alreadyAdded: expect.any(Boolean) },
      { name: "Teeth Whitening", landing_page_url: null, alreadyAdded: expect.any(Boolean) },
    ]);
  });

  it("returns candidates from the mapped site", async () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "fc-test");
    resetConfigCache();
    const site = getDemoStore().clients.find((c) => c.id === "client_modern_dental")!.website_url;
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({ success: true, links: [`${site}/collections/implants`, `${site}/cart`] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { data } = await call();
    expect(data.source).toBe("firecrawl");
    expect(data.candidates).toEqual([
      { name: "Implants", landing_page_url: `${site}/collections/implants`, alreadyAdded: false },
    ]);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.firecrawl.dev/v1/map");
  });
});

describe("matchServicePages (service sites with no category paths)", () => {
  // Real paths from trafficradius.com.au: service pages sit at the top level
  // next to hundreds of blog posts, so only the service names can find them.
  const TR = "https://trafficradius.com.au/";
  const urls = [
    "/",
    "/seo-services",
    "/seo-services-explained",
    "/seo-services-cost-sydney-pricing-guide",
    "/local-seo-services",
    "/local-seo-for-perth-businesses-boost-rankings-with-the-best-strategies",
    "/google-ads-management",
    "/google-adwords-express",
    "/meta-ads",
    "/social-media-marketing",
    "/link-building",
    "/blog",
    "/about-us",
  ].map((p) => `https://trafficradius.com.au${p}`);

  it("matches each service name to its own page, not to blog posts that mention it", () => {
    const out = matchServicePages(
      ["SEO Services", "Local SEO", "Google Ads Management", "Meta Ads", "Social Media Marketing", "Link Building"],
      urls,
      TR,
      [],
    );
    expect(out).toEqual([
      { name: "Google Ads Management", landing_page_url: "https://trafficradius.com.au/google-ads-management", alreadyAdded: false },
      { name: "Link Building", landing_page_url: "https://trafficradius.com.au/link-building", alreadyAdded: false },
      { name: "Local SEO", landing_page_url: "https://trafficradius.com.au/local-seo-services", alreadyAdded: false },
      { name: "Meta Ads", landing_page_url: "https://trafficradius.com.au/meta-ads", alreadyAdded: false },
      { name: "SEO Services", landing_page_url: "https://trafficradius.com.au/seo-services", alreadyAdded: false },
      { name: "Social Media Marketing", landing_page_url: "https://trafficradius.com.au/social-media-marketing", alreadyAdded: false },
    ]);
  });

  it("keeps a service with no matching page, without pointing it at the homepage", () => {
    const out = matchServicePages(["Email Marketing"], urls, TR, []);
    expect(out).toEqual([{ name: "Email Marketing", landing_page_url: null, alreadyAdded: false }]);
  });

  it("doesn't link a service to a long blog post that only mentions it", () => {
    const withPost = [...urls, "https://trafficradius.com.au/10-proven-tips-to-maximise-roi-in-ppc-advertising"];
    const out = matchServicePages(["PPC Advertising", "Web Development Services"], [...withPost, "https://trafficradius.com.au/php-web-development-services"], TR, []);
    expect(out).toEqual([
      { name: "PPC Advertising", landing_page_url: null, alreadyAdded: false },
      { name: "Web Development Services", landing_page_url: "https://trafficradius.com.au/php-web-development-services", alreadyAdded: false },
    ]);
  });

  it("treats singular and plural the same", () => {
    const out = matchServicePages(["SEO Service"], urls, TR, []);
    expect(out[0]!.landing_page_url).toBe("https://trafficradius.com.au/seo-services");
  });

  it("marks services already added by name or by page", () => {
    const existing = [
      { id: "a", client_id: "c", name: "seo services", landing_page_url: null },
      { id: "b", client_id: "c", name: "Paid Social", landing_page_url: "https://trafficradius.com.au/meta-ads" },
    ] as ClientService[];
    const out = matchServicePages(["SEO Services", "Meta Ads", "Link Building"], urls, TR, existing);
    expect(out.map((c) => [c.name, c.alreadyAdded])).toEqual([
      ["Link Building", false],
      ["Meta Ads", true],
      ["SEO Services", true],
    ]);
  });

  it("de-duplicates names and ignores blanks", () => {
    const out = matchServicePages(["Meta Ads", "meta ads", "  "], urls, TR, []);
    expect(out.map((c) => c.name)).toEqual(["Meta Ads"]);
  });
});

describe("fetchCategorySitemapUrls (stores whose map is all product pages)", () => {
  // Shape of duringdays.com.au's real sitemap: an index of product, page,
  // collection and blog sitemaps, with &amp; in the child URLs.
  const DD = "https://www.duringdays.com.au/";
  const index = `<?xml version="1.0"?><sitemapindex>
    <sitemap><loc>https://www.duringdays.com.au/sitemap_products_1.xml?from=1&amp;to=2</loc></sitemap>
    <sitemap><loc>https://www.duringdays.com.au/sitemap_pages_1.xml</loc></sitemap>
    <sitemap><loc>https://www.duringdays.com.au/sitemap_collections_1.xml?from=286&amp;to=321</loc></sitemap>
    <sitemap><loc>https://www.duringdays.com.au/sitemap_collections_2.xml?from=322&amp;to=335</loc></sitemap>
    <sitemap><loc>https://www.duringdays.com.au/sitemap_blogs_1.xml</loc></sitemap>
  </sitemapindex>`;
  const collections1 = `<urlset><url><loc>https://www.duringdays.com.au/collections/furniture</loc></url>
    <url><loc>https://www.duringdays.com.au/collections/bar-stools</loc></url></urlset>`;
  const collections2 = `<urlset><url><loc>https://www.duringdays.com.au/collections/mannequins</loc></url></urlset>`;

  // The real reader (route tests above use a mock of it).
  const realFetch = async (...args: Parameters<typeof fetchCategorySitemapUrls>) =>
    (await vi.importActual<typeof import("@/lib/scraping/site-map")>("@/lib/scraping/site-map")).fetchCategorySitemapUrls(...args);
  const deps = (responses: Record<string, string | null>) => {
    const seen: string[] = [];
    return {
      seen,
      deps: {
        assertPublic: vi.fn().mockResolvedValue(undefined),
        fetchImpl: vi.fn(async (url: string) => {
          seen.push(url);
          const body = responses[url];
          return body == null ? new Response("missing", { status: 404 }) : new Response(body, { status: 200 });
        }) as unknown as typeof fetch,
      },
    };
  };

  it("reads only the collection sitemaps listed in the index", async () => {
    const { seen, deps: d } = deps({
      "https://www.duringdays.com.au/sitemap.xml": index,
      "https://www.duringdays.com.au/sitemap_collections_1.xml?from=286&to=321": collections1,
      "https://www.duringdays.com.au/sitemap_collections_2.xml?from=322&to=335": collections2,
    });
    const urls = await realFetch(DD, d);
    expect(urls).toEqual([
      "https://www.duringdays.com.au/collections/furniture",
      "https://www.duringdays.com.au/collections/bar-stools",
      "https://www.duringdays.com.au/collections/mannequins",
    ]);
    expect(seen.some((u) => u.includes("products"))).toBe(false);
    expect(seen.some((u) => u.includes("blogs"))).toBe(false);
    // Every fetched URL passes the public-address guard first.
    expect(d.assertPublic).toHaveBeenCalledTimes(3);
  });

  it("finds category pages in a plain sitemap with no index", async () => {
    const { deps: d } = deps({
      "https://www.duringdays.com.au/sitemap.xml": `<urlset><url><loc>https://www.duringdays.com.au/product-category/sofas/</loc></url></urlset>`,
    });
    expect(await realFetch(DD, d)).toEqual(["https://www.duringdays.com.au/product-category/sofas/"]);
  });

  it("returns nothing, without throwing, when there is no sitemap or the guard refuses", async () => {
    const { deps: d } = deps({});
    expect(await realFetch(DD, d)).toEqual([]);
    const blocked = { ...deps({}).deps, assertPublic: vi.fn().mockRejectedValue(new Error("not public")) };
    expect(await realFetch("http://10.0.0.1/", blocked)).toEqual([]);
  });
});

describe("GET discover with a store whose map is all product pages", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetConfigCache();
  });

  it("finds the collections from the sitemap", async () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "fc-test");
    resetConfigCache();
    const site = getDemoStore().clients.find((c) => c.id === "client_modern_dental")!.website_url!;
    const origin = new URL(site).origin;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ success: true, links: [`${origin}/products/oak-stool`, `${origin}/products/pine-stool`] })),
    );
    vi.mocked(fetchCategorySitemapUrls).mockResolvedValueOnce([`${origin}/collections/bar-stools`, `${origin}/collections/sofas`]);
    const p = getDemoStore().profiles.find((x) => x.role === "operator")!;
    vi.mocked(getCurrentUser).mockResolvedValue({ id: p.id, email: p.email, profile: p });
    const { GET } = await import("@/app/api/clients/[id]/services/discover/route");
    const res = await GET(new Request("http://app.test/x"), { params: Promise.resolve({ id: "client_modern_dental" }) });
    const { data } = (await res.json()) as { data: { candidates: Array<{ name: string }>; source: string } };
    expect(data.source).toBe("firecrawl");
    expect(data.candidates.map((c) => c.name)).toEqual(["Bar Stools", "Sofas"]);
    // Shop categories were found, so the service-name fallback never ran.
    expect(scrapeWebsiteServices).not.toHaveBeenCalled();
  });
});
