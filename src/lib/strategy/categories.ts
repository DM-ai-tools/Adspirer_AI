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
