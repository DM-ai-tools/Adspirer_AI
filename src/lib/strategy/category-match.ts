import type { StrategyCategory } from "./categories";

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Lowercase host + path, with port, leading "www.", query, hash and trailing slash removed. */
export function normalizeUrl(raw: string): string | null {
  try {
    const u = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.hostname.replace(/^www\./i, "")}${path}`.toLowerCase();
  } catch {
    return null;
  }
}

/** Length of the best url match for a category, or 0 for none. */
function urlScore(url: string, category: StrategyCategory): number {
  let best = 0;
  if (category.landingPageUrl) {
    const target = normalizeUrl(category.landingPageUrl);
    // A bare host would swallow every page on the site, so only paths count.
    if (target && target.includes("/") && (url === target || url.startsWith(`${target}/`))) {
      best = target.length;
    }
  }
  for (const pattern of category.urlPatterns) {
    const p = pattern.trim().toLowerCase();
    if (p && url.includes(p)) best = Math.max(best, p.length);
  }
  return best;
}

/** Length of the longest whole-word, case-insensitive term found in the text. */
function nameScore(text: string, category: StrategyCategory): number {
  let best = 0;
  for (const raw of [category.name, ...category.keywords]) {
    const term = raw.trim();
    if (!term) continue;
    const re = new RegExp(`(?<![a-z0-9])${escapeRegExp(term)}(?![a-z0-9])`, "i");
    if (re.test(text)) best = Math.max(best, term.length);
  }
  return best;
}

/** The category with the highest score above 0; ties go to the first in list order. */
function best(
  categories: StrategyCategory[],
  score: (category: StrategyCategory) => number,
): StrategyCategory | null {
  let winner: StrategyCategory | null = null;
  let winnerScore = 0;
  for (const category of categories) {
    const s = score(category);
    if (s > winnerScore) {
      winner = category;
      winnerScore = s;
    }
  }
  return winner;
}

/** Longest path prefix or url_pattern substring wins. */
export function matchCategoryByUrl(url: string, categories: StrategyCategory[]): StrategyCategory | null {
  const normalized = normalizeUrl(url);
  if (!normalized) return null;
  return best(categories, (c) => urlScore(normalized, c));
}

/** The first text with a hit decides; within it the longest term wins. */
export function matchCategoryByName(
  texts: Array<string | null | undefined>,
  categories: StrategyCategory[],
): StrategyCategory | null {
  for (const text of texts) {
    if (!text) continue;
    const hit = best(categories, (c) => nameScore(text, c));
    if (hit) return hit;
  }
  return null;
}

function exactLabel(label: string, categories: StrategyCategory[]): StrategyCategory | null {
  const wanted = label.trim().toLowerCase();
  if (!wanted) return null;
  return (
    categories.find((c) => [c.name, ...c.keywords].some((t) => t.trim().toLowerCase() === wanted)) ?? null
  );
}

/**
 * A product-type or item-category label (GA4 itemCategory, Shopping product type):
 * exact name/keyword first, then each segment of a "A > B" or "A/B" path from the
 * last to the first, then a whole-word match on the full label.
 */
export function matchCategoryByLabel(label: string, categories: StrategyCategory[]): StrategyCategory | null {
  const exact = exactLabel(label, categories);
  if (exact) return exact;
  const segments = label.split(/[>/]/);
  if (segments.length > 1) {
    for (let i = segments.length - 1; i >= 0; i--) {
      const hit = exactLabel(segments[i], categories);
      if (hit) return hit;
    }
  }
  return best(categories, (c) => nameScore(label, c));
}
