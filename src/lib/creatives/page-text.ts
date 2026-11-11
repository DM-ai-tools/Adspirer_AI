/**
 * The readable text of a web page, for steps that need what a landing page really says (the edit
 * step, the client-results finder). Image lines and link targets are dropped so a page with dozens
 * of logo images does not crowd out the words. Pages are kept for a few minutes so several edits or
 * a run and its first edit do not read the same page again.
 */

/** Most page text given to a model. Long enough for a full landing page. */
export const PAGE_CHARS = 30_000;
const CACHE_MS = 10 * 60 * 1000;

export type PageText = { at: number; text: string; readable: boolean };
const cache = new Map<string, PageText>();

/** Page text without image lines and link targets. */
export function cleanPageText(markdown: string): string {
  return markdown
    .split("\n")
    .filter((line) => !/^\s*!\[[^\]]*\]\([^)]*\)\s*$/.test(line))
    .map((line) => line.replace(/\]\((?:https?:\/\/|#|\/)[^)]*\)/g, "]"))
    .filter((line) => line.trim())
    .join("\n");
}

/** Read a page (or reuse a recent read). Throws when it cannot be opened; `readable` is false when it held no usable text. */
export async function readPageText(url: string): Promise<PageText> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit;
  const { scrapeWebsiteServices } = await import("@/lib/scraping/firecrawl");
  const scraped = await scrapeWebsiteServices(url, { extractServices: false, maxChars: PAGE_CHARS * 2 });
  const text = cleanPageText(scraped.markdown ?? "").slice(0, PAGE_CHARS);
  const readable = scraped.source !== "heuristic" && text.length > 80;
  const out = { at: Date.now(), text, readable };
  if (readable) cache.set(url, out);
  return out;
}

export function clearPageCache(): void {
  cache.clear();
}
