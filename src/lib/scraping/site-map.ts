import type { ClientService } from "@/types";
import { getConfig } from "@/lib/config";

export type CategoryCandidate = {
  name: string;
  /** null when a service was found on the site but no page of its own matched it. */
  landing_page_url: string | null;
  alreadyAdded: boolean;
};

const CATEGORY_MARKERS = [
  "/collections/",
  "/category/",
  "/categories/",
  "/product-category/",
  "/c/",
  "/shop/",
  "/department/",
];

// duringdays.com.au alone has 2,451 collections; never cut a real catalogue short.
const MAX_CANDIDATES = 5000;

/** List URLs on a site via Firecrawl's map endpoint. Throws on failure. */
export async function mapSiteUrls(
  siteUrl: string,
  opts?: { limit?: number },
): Promise<string[]> {
  const apiKey = getConfig().FIRECRAWL_API_KEY;
  if (!apiKey) throw new Error("FIRECRAWL_API_KEY is not set");
  const response = await fetch("https://api.firecrawl.dev/v1/map", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url: siteUrl, limit: opts?.limit ?? 5000 }),
    signal: AbortSignal.timeout(60_000),
  });
  const payload = (await response.json().catch(() => null)) as {
    links?: unknown;
  } | null;
  if (!response.ok) throw new Error(`Firecrawl map failed (${response.status})`);
  return Array.isArray(payload?.links)
    ? payload.links.filter((l): l is string => typeof l === "string")
    : [];
}

function parseUrl(raw: string, base?: string): URL | null {
  try {
    return new URL(raw, base);
  } catch {
    return null;
  }
}

/** Hostname for comparison: lowercase, no port, no leading "www.". */
function siteHost(u: URL): string {
  return u.hostname.toLowerCase().replace(/^www\./, "");
}

/** The segment decoded, or as written when it holds a stray "%" ("100%-wool"). */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Lowercase path with query and trailing slash removed. */
function normalizePath(pathname: string): string {
  const path = pathname.toLowerCase().replace(/\/+$/, "");
  return path || "/";
}

function titleCase(slug: string): string {
  return slug
    .replace(/-+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export type CategoryPage = {
  /** Canonical lowercase path, e.g. "/collections/bar-stools". */
  path: string;
  /** The page's URL, in the casing it was found with. */
  url: string;
  /** The name read from its slug ("Bar Stools"). */
  name: string;
};

/**
 * The category page a URL on the site belongs to: a collection-style path
 * ("/collections/x", "/category/x", …), with nested product and pagination
 * segments dropped. null for other sites and for pages that aren't under a
 * category path.
 */
export function categoryPageOf(raw: string, siteUrl: string | URL): CategoryPage | null {
  const site = typeof siteUrl === "string" ? parseUrl(siteUrl) : siteUrl;
  const u = parseUrl(raw);
  if (!site || !u || siteHost(u) !== siteHost(site)) return null;
  const full = normalizePath(u.pathname);
  const marker = CATEGORY_MARKERS.find((m) => full.includes(m));
  if (!marker) return null;
  const at = full.indexOf(marker) + marker.length;
  const segment = full.slice(at).split("/")[0];
  if (!segment) return null;
  // Original casing for the URL; the marker and segment have the same length
  const original = u.pathname.slice(0, at) + u.pathname.slice(at).split("/")[0];
  return {
    path: full.slice(0, at) + segment,
    url: `${u.origin}${original}`,
    name: titleCase(decodeSegment(segment)),
  };
}

/** Normalized paths of the existing services' landing pages on the site. */
export function addedCategoryPaths(existing: ClientService[], siteUrl: string): Set<string> {
  const added = new Set<string>();
  for (const s of existing) {
    const u = s.landing_page_url ? parseUrl(s.landing_page_url, siteUrl) : null;
    if (u) added.add(normalizePath(u.pathname));
  }
  return added;
}

export function discoverCategoryCandidates(
  urls: string[],
  siteUrl: string,
  existing: ClientService[],
): CategoryCandidate[] {
  const site = parseUrl(siteUrl);
  if (!site) return [];
  const added = addedCategoryPaths(existing, siteUrl);

  const byPath = new Map<string, CategoryCandidate>();
  for (const raw of urls) {
    const page = categoryPageOf(raw, site);
    if (!page || byPath.has(page.path)) continue;
    byPath.set(page.path, {
      name: page.name,
      landing_page_url: page.url,
      alreadyAdded: added.has(page.path),
    });
  }

  return [...byPath.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_CANDIDATES);
}

const STOPWORDS = new Set(["and", "the", "a", "an", "of", "for", "our", "in", "to", "with", "on", "by"]);
/** Share of a page's words that must come from the service name. */
const MIN_SERVICE_PAGE_MATCH = 0.5;

/** Lowercase words with stopwords dropped and a plural "s" trimmed ("Services" → "service"). */
function slugWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOPWORDS.has(w))
    .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
}

/**
 * Service sites (agencies, clinics) keep their service pages at the top level
 * next to blog posts, so paths alone can't find them. Given service names read
 * from the site, pick each one's own page: a page of at most two path segments
 * whose words include every word of the name, closest match first (so "SEO
 * Services" is /seo-services, not /seo-services-explained). A name with no
 * such page is kept with no landing page rather than the homepage.
 */
export function matchServicePages(
  names: string[],
  urls: string[],
  siteUrl: string,
  existing: ClientService[],
): CategoryCandidate[] {
  const site = parseUrl(siteUrl);
  if (!site) return [];
  const addedPaths = new Set<string>();
  const addedNames = new Set(existing.map((s) => s.name.trim().toLowerCase()));
  for (const s of existing) {
    const u = s.landing_page_url ? parseUrl(s.landing_page_url, siteUrl) : null;
    if (u) addedPaths.add(normalizePath(u.pathname));
  }

  const pages: Array<{ url: string; path: string; words: Set<string> }> = [];
  const seenPaths = new Set<string>();
  for (const raw of urls) {
    const u = parseUrl(raw);
    if (!u || siteHost(u) !== siteHost(site)) continue;
    const path = normalizePath(u.pathname);
    const segments = path.split("/").filter(Boolean);
    if (!segments.length || segments.length > 2 || seenPaths.has(path)) continue;
    seenPaths.add(path);
    pages.push({ url: `${u.origin}${u.pathname.replace(/\/+$/, "")}`, path, words: new Set(slugWords(decodeSegment(path))) });
  }

  const byName = new Map<string, CategoryCandidate>();
  for (const raw of names) {
    const name = raw.trim();
    const key = name.toLowerCase();
    if (!name || byName.has(key)) continue;
    const wanted = slugWords(name);
    let best: { url: string; path: string; score: number } | null = null;
    if (wanted.length) {
      for (const page of pages) {
        if (!wanted.every((w) => page.words.has(w))) continue;
        const score = wanted.length / page.words.size;
        // Mostly the service's own words; a long post title that mentions it isn't its page.
        if (score < MIN_SERVICE_PAGE_MATCH) continue;
        if (!best || score > best.score || (score === best.score && page.path.length < best.path.length)) {
          best = { url: page.url, path: page.path, score };
        }
      }
    }
    byName.set(key, {
      name,
      landing_page_url: best?.url ?? null,
      alreadyAdded: addedNames.has(key) || (best ? addedPaths.has(best.path) : false),
    });
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_CANDIDATES);
}

/** Child sitemaps worth reading: shop collections and category lists, never products or posts. */
const CATEGORY_SITEMAP = /collection|categor|product[-_]cat|department/i;
const MAX_CATEGORY_SITEMAPS = 10;
const MAX_SITEMAP_URLS = 20_000;

type SitemapDeps = {
  fetchImpl?: typeof fetch;
  /** Refuses internal addresses (SSRF guard); defaults to assertPublicUrl. */
  assertPublic?: (url: string) => Promise<void>;
};

function sitemapLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) =>
    m[1]!.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'"),
  );
}

/**
 * Large stores fill the 5,000-URL crawl map with product pages before any
 * collection page appears (duringdays.com.au: 4,973 of 5,000). Shopify and
 * WooCommerce list their collections / categories in their own sitemaps, so
 * read /sitemap.xml and, when it is an index, only the collection and category
 * child sitemaps. Never throws: no sitemap or a refused address returns [].
 */
export async function fetchCategorySitemapUrls(siteUrl: string, deps: SitemapDeps = {}): Promise<string[]> {
  const site = parseUrl(siteUrl);
  if (!site) return [];
  const fetchImpl = deps.fetchImpl ?? fetch;
  const assertPublic =
    deps.assertPublic ?? (async (url: string) => (await import("@/lib/security/public-url")).assertPublicUrl(url));

  const read = async (url: string): Promise<string | null> => {
    try {
      await assertPublic(url);
      const res = await fetchImpl(url, {
        headers: { "User-Agent": "AdspirerAIBot/1.0" },
        signal: AbortSignal.timeout(15_000),
      });
      return res.ok ? await res.text() : null;
    } catch {
      return null;
    }
  };

  const root = await read(`${site.origin}/sitemap.xml`);
  if (!root) return [];
  const locs = sitemapLocs(root);
  if (!/<sitemapindex/i.test(root)) return locs.slice(0, MAX_SITEMAP_URLS);

  const children = locs.filter((u) => CATEGORY_SITEMAP.test(u)).slice(0, MAX_CATEGORY_SITEMAPS);
  const urls: string[] = [];
  for (const child of children) {
    const xml = await read(child);
    if (xml) urls.push(...sitemapLocs(xml));
    if (urls.length >= MAX_SITEMAP_URLS) break;
  }
  return urls.slice(0, MAX_SITEMAP_URLS);
}
