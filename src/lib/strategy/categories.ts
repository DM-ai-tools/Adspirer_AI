import type { ClientService } from "@/types/database";
import { escapeRegExp, matchCategoryByName } from "./category-match";

export type StrategyCategory = {
  id: string;
  name: string;
  landingPageUrl: string | null;
  urlPatterns: string[];
  keywords: string[];
  grossMarginPct: number | null;
  averageOrderValueCents: number | null;
  priority: number;
};

/** Active services as strategy categories; missing values get neutral defaults. */
export function categoriesFromServices(services: ClientService[]): StrategyCategory[] {
  return services
    .filter((s) => s.is_active)
    .map((s) => ({
      id: s.id,
      name: s.name,
      landingPageUrl: s.landing_page_url ?? null,
      urlPatterns: s.url_patterns ?? [],
      keywords: s.keywords ?? [],
      grossMarginPct: s.gross_margin_pct ?? null,
      averageOrderValueCents: s.average_order_value_cents ?? null,
      priority: s.priority ?? 0,
    }));
}

const SPEND_RETURN_WORDS = /\b(?:spend|spent|spending|return|returns|returned|revenue|roas|best|top)\b/i;
const CATEGORY_WORDS = /\b(?:categor(?:y|ies)|services?)\b/i;

/**
 * A question about spend and return by category: it names one of the client's
 * categories (whole word, any case), or says "category" / "service" next to a
 * spend, return, best or top word.
 */
export function asksAboutCategorySpend(request: string, categories: StrategyCategory[]): boolean {
  const named = categories.some((c) => {
    const name = c.name.trim();
    return name !== "" && new RegExp(`(?<![a-z0-9])${escapeRegExp(name)}(?![a-z0-9])`, "i").test(request);
  });
  return named || (CATEGORY_WORDS.test(request) && SPEND_RETURN_WORDS.test(request));
}

/**
 * The question judges categories by what they return for their spend ("sales with respect to
 * spend", ROAS, efficiency), not just by sales. Tolerates typos in "with respect to".
 */
const RETURN_ON_SPEND =
  /\b(?:roas|return\s+on\s+(?:ad\s+)?spend|with\s+\w+\s+to\s+(?:the\s+)?(?:ad\s+)?spend|relative\s+to\s+(?:the\s+)?(?:ad\s+)?spend|(?:vs\.?|versus|against)\s+(?:the\s+)?(?:ad\s+)?spend|(?:per|for\s+every|for\s+each)\s+(?:dollar|buck)|efficien\w*|bang\s+for|best\s+return)/i;
export function asksForReturnOnSpend(request: string): boolean {
  return RETURN_ON_SPEND.test(request);
}

/** Names that mean "everything" rather than one category. */
export const GENERIC_NAMES = new Set(["all", "other", "others", "general", "misc", "miscellaneous", "uncategorized", "uncategorised", "default"]);

/**
 * The categories a request names (whole-word name or keyword, any case), in
 * category order. A category called only "All", "Other" or "General" never matches.
 */
export function scopeCategoriesFromRequest(request: string, categories: StrategyCategory[]): StrategyCategory[] {
  return categories.filter(
    (c) => !GENERIC_NAMES.has(c.name.trim().toLowerCase()) && matchCategoryByName([request], [c]) != null,
  );
}
