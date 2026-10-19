import type { ClientService } from "@/types/database";

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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
