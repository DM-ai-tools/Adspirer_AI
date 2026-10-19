import type { ClientService } from "@/types";
import { getConfig } from "@/lib/config";

export type CategoryCandidate = {
  name: string;
  landing_page_url: string;
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
    if (!u || u.host.toLowerCase() !== site.host.toLowerCase()) continue;
    const path = normalizePath(u.pathname);
    if (byPath.has(path)) continue;
    const marker = CATEGORY_MARKERS.find((m) => path.includes(m));
    if (!marker) continue;
    const segment = path.slice(path.indexOf(marker) + marker.length).split("/")[0];
    if (!segment) continue;
    byPath.set(path, {
      name: titleCase(decodeURIComponent(segment)),
      landing_page_url: `${u.origin}${u.pathname.replace(/\/+$/, "")}`,
      alreadyAdded: added.has(path),
    });
  }

  return [...byPath.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_CANDIDATES);
}
