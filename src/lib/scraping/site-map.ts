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

const MAX_CANDIDATES = 1000;

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

export function discoverCategoryCandidates(
  urls: string[],
  siteUrl: string,
  existing: ClientService[],
): CategoryCandidate[] {
  const site = parseUrl(siteUrl);
  if (!site) return [];
  const added = new Set<string>();
  for (const s of existing) {
    const u = s.landing_page_url ? parseUrl(s.landing_page_url, siteUrl) : null;
    if (u) added.add(normalizePath(u.pathname));
  }

  const byPath = new Map<string, CategoryCandidate>();
  for (const raw of urls) {
    const u = parseUrl(raw);
    if (!u || siteHost(u) !== siteHost(site)) continue;
    const full = normalizePath(u.pathname);
    const marker = CATEGORY_MARKERS.find((m) => full.includes(m));
    if (!marker) continue;
    const at = full.indexOf(marker) + marker.length;
    const segment = full.slice(at).split("/")[0];
    if (!segment) continue;
    // Canonical category path: drop nested product / pagination segments
    const path = full.slice(0, at) + segment;
    if (byPath.has(path)) continue;
    // Original casing for the URL; the marker and segment have the same length
    const original = u.pathname.slice(0, at) + u.pathname.slice(at).split("/")[0];
    byPath.set(path, {
      name: titleCase(decodeSegment(segment)),
      landing_page_url: `${u.origin}${original}`,
      alreadyAdded: added.has(path),
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
