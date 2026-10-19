import { afterEach, describe, expect, it, vi } from "vitest";
import { getDemoStore } from "@/lib/demo/store";
import { resetConfigCache } from "@/lib/config";
import { discoverCategoryCandidates } from "@/lib/scraping/site-map";
import type { ClientService } from "@/types";

vi.mock("@/lib/security/auth", () => ({ getCurrentUser: vi.fn() }));
import { getCurrentUser } from "@/lib/security/auth";

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

  it("flags candidates already added, ignoring host, case, slash and query", () => {
    const out = discoverCategoryCandidates(
      [`${SITE}/collections/bar-stools`, `${SITE}/collections/sofas`],
      SITE,
      [svc("https://www.other.example/Collections/Bar-Stools/?utm=1")],
    );
    expect(out.find((c) => c.name === "Bar Stools")?.alreadyAdded).toBe(true);
    expect(out.find((c) => c.name === "Sofas")?.alreadyAdded).toBe(false);
  });

  it("caps at 1000 and sorts by name", () => {
    const urls = Array.from({ length: 1200 }, (_, i) => `${SITE}/collections/cat-${i}`);
    const out = discoverCategoryCandidates(urls, SITE, []);
    expect(out).toHaveLength(1000);
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
    expect(data).toEqual({ candidates: [], source: "unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is unavailable when the map call fails", async () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "fc-test");
    resetConfigCache();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 500 })));
    const { data } = await call();
    expect(data).toEqual({ candidates: [], source: "unavailable" });
  });

  it("is unavailable when fetch throws", async () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "fc-test");
    resetConfigCache();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    const { data } = await call();
    expect(data).toEqual({ candidates: [], source: "unavailable" });
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
