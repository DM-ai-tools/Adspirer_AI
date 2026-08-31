/** Approvals often use `daily_budget`; executor/provider expect `budget_daily` (major units, e.g. 5 = £5). */
export function resolveBudgetDaily(
  args: Record<string, unknown>,
): number | undefined {
  for (const key of ["budget_daily", "daily_budget"] as const) {
    const raw = args[key];
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
    if (typeof raw === "string" && raw.trim()) {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return undefined;
}
