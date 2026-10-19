import type { StrategyCategory } from "@/lib/strategy/categories";

/** A margin percent counts as known only when it is a finite number above zero. */
function knownMargin(margin: number | null | undefined): number | null {
  return typeof margin === "number" && Number.isFinite(margin) && margin > 0 ? margin : null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Target ROAS for one category, keeping the account's profit per ad dollar
 * the same across categories: T_c = T x m_account / m_category.
 * Margins are percents (30 means 30%).
 */
export function categoryTargetRoas(input: {
  accountTargetRoas: number;
  accountMarginPct: number | null;
  categoryMarginPct: number | null;
}): { targetRoas: number; breakEvenRoas: number | null; basis: "margin_adjusted" | "account_target" } {
  const accountMargin = knownMargin(input.accountMarginPct);
  const categoryMargin = knownMargin(input.categoryMarginPct);
  const breakEvenRoas = categoryMargin === null ? null : round2(100 / categoryMargin);

  if (accountMargin === null || categoryMargin === null) {
    return { targetRoas: round2(input.accountTargetRoas), breakEvenRoas, basis: "account_target" };
  }
  return {
    targetRoas: round2((input.accountTargetRoas * accountMargin) / categoryMargin),
    breakEvenRoas,
    basis: "margin_adjusted",
  };
}

/**
 * Margin used as the reference for the account: the goals margin when set,
 * otherwise the mean of the known category margins, or null if there are none.
 */
export function referenceMarginPct(
  goalsMarginPct: number | null | undefined,
  categories: StrategyCategory[],
): number | null {
  const goalsMargin = knownMargin(goalsMarginPct);
  if (goalsMargin !== null) return goalsMargin;

  const known = categories
    .map((c) => knownMargin(c.grossMarginPct))
    .filter((m): m is number => m !== null);
  if (known.length === 0) return null;
  return round2(known.reduce((sum, m) => sum + m, 0) / known.length);
}
