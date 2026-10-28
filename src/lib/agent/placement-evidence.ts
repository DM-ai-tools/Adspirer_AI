import type { MetaAdSet } from "@/lib/adspirer/provider";
import type { AgentToolCallProposal } from "@/lib/agent/adspirer-agent";
import type { BriefPeriod } from "@/lib/agent/request-brief";
import { placementStateOf } from "@/lib/meta/adset-edits";
import { formatMoney } from "@/lib/monitoring/health";

/**
 * Where each ad set's money went, by platform, and which platform to stop running on.
 *
 * Proposals are at platform level on purpose: Meta's breakdown position names do not line up
 * with its targeting position names, so positions are shown as evidence and never edited from
 * a guess. A platform is offered for removal when it costs at least twice the ad set's average
 * per result and takes at least a tenth of its spend, or when it spent as much as a day's
 * budget (and at least 10) with no results while other placements convert. The best platform
 * always stays, and an ad set on automatic placements is never given a manual list.
 */

const PLATFORM_LABEL: Record<string, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  audience_network: "Audience Network",
  messenger: "Messenger",
};
const platformLabel = (p: string) => PLATFORM_LABEL[p] ?? p;

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Results for one breakdown row, read the way the ad set counts them. null when the ad set's
 * result type can't be read, in which case no verdict is given. A missing `actions` field is
 * zero results: Meta omits it when there are none.
 */
function resultsOf(row: Record<string, unknown>, adset: MetaAdSet): number | null {
  const goal = (adset.optimization_goal ?? "").toUpperCase();
  const event = (adset.custom_event_type ?? "").toLowerCase();
  const actions = (row.actions && typeof row.actions === "object" ? row.actions : {}) as Record<string, unknown>;
  const pick = (keys: string[]) => {
    for (const key of keys) {
      const value = actions[key];
      if (typeof value === "number") return value;
    }
    return 0;
  };
  if (goal === "LINK_CLICKS") return pick(["link_click"]);
  if (goal === "LANDING_PAGE_VIEWS") return pick(["landing_page_view"]);
  if (event) return pick([event, `omni_${event}`, `offsite_conversion.fb_pixel_${event}`, `onsite_conversion.${event}_grouped`]);
  return null;
}

type Agg = { spend: number; results: number };

export function placementPart(input: {
  rows: Array<Record<string, unknown>>;
  adsets: MetaAdSet[];
  period: BriefPeriod;
  currency: string | null;
  partial: boolean;
}): { section: string; proposals: AgentToolCallProposal[] } {
  const money = (amount: number) => formatMoney(Math.round(amount * 100), input.currency ?? "USD");
  const plural = (n: number) => `${n} result${n === 1 ? "" : "s"}`;
  const lines: string[] = [];
  const proposals: AgentToolCallProposal[] = [];

  const byAdset = new Map<string, Array<Record<string, unknown>>>();
  for (const row of input.rows) {
    const id = str(row.adset_id);
    if (id) byAdset.set(id, [...(byAdset.get(id) ?? []), row]);
  }
  const spendOf = (rows: Array<Record<string, unknown>>) => rows.reduce((sum, r) => sum + (num(r.spend) ?? 0), 0);
  const shown = input.adsets
    .filter((a) => byAdset.has(a.id) && spendOf(byAdset.get(a.id)!) > 0)
    .sort((a, b) => spendOf(byAdset.get(b.id)!) - spendOf(byAdset.get(a.id)!))
    .slice(0, 10);

  for (const adset of shown) {
    const rows = byAdset.get(adset.id)!;
    const total = spendOf(rows);
    let state = placementStateOf(null);
    try {
      state = placementStateOf(adset.targeting_summary ? JSON.parse(adset.targeting_summary) : null);
    } catch {
      // Unreadable targeting is treated as automatic, so nothing is proposed for it.
    }
    if (!state.publisher_platforms) {
      lines.push(
        `- ${adset.name}: automatic placements (Meta chooses where the ads run), ${money(total)} spent. There is no manual list to trim; say which placements you want if you'd like to move off automatic.`,
      );
      continue;
    }

    const platforms = new Map<string, Agg>();
    const positions: Array<{ name: string } & Agg> = [];
    let totalResults = 0;
    let known = true;
    for (const row of rows) {
      const results = resultsOf(row, adset);
      if (results == null) known = false;
      const spend = num(row.spend) ?? 0;
      const platform = str(row.publisher_platform) ?? "unknown";
      const into = platforms.get(platform) ?? { spend: 0, results: 0 };
      into.spend += spend;
      into.results += results ?? 0;
      platforms.set(platform, into);
      positions.push({ name: str(row.platform_position) ?? "unknown", spend, results: results ?? 0 });
      totalResults += results ?? 0;
    }
    const platformText = [...platforms.entries()]
      .sort((a, b) => b[1].spend - a[1].spend)
      .map(([p, a]) =>
        known
          ? `${platformLabel(p)} ${money(a.spend)}, ${plural(a.results)}${a.results > 0 ? `, ${money(a.spend / a.results)} each` : ""}`
          : `${platformLabel(p)} ${money(a.spend)}`,
      )
      .join(" · ");
    lines.push(`- ${adset.name} (${money(total)} in ${input.period.label}): ${platformText}`);
    if (!known) {
      lines.push("  I can't read results for this ad set's goal, so placements are shown without a verdict.");
      continue;
    }

    const weakestPositions = [...positions]
      .filter((p) => p.spend > 0)
      .sort((a, b) => b.spend / (b.results || 0.5) - a.spend / (a.results || 0.5))
      .slice(0, 2)
      .map((p) => `${p.name.replaceAll("_", " ")} (${money(p.spend)}, ${plural(p.results)})`);
    if (weakestPositions.length) lines.push(`  Weakest positions: ${weakestPositions.join("; ")}`);
    if (totalResults <= 0) {
      lines.push("  No placement produced results in this period, so none is singled out.");
      continue;
    }

    const average = total / totalResults;
    const dailyBudget = (adset.daily_budget_cents ?? 0) / 100;
    let weak = state.publisher_platforms.filter((p) => {
      const a = platforms.get(p);
      if (!a) return false;
      const costly = a.results > 0 && a.spend / a.results >= 2 * average && a.spend >= 0.1 * total;
      const wasted = a.results === 0 && a.spend >= Math.max(10, dailyBudget);
      return costly || wasted;
    });
    if (!weak.length) continue;

    let remaining = state.publisher_platforms.filter((p) => !weak.includes(p));
    if (!remaining.length) {
      // Never leave an ad set with no placement: keep the platform that converts best.
      const best = [...platforms.entries()]
        .filter(([p, a]) => a.results > 0 && state.publisher_platforms!.includes(p))
        .sort((a, b) => a[1].spend / a[1].results - b[1].spend / b[1].results)[0]?.[0];
      if (!best) continue;
      remaining = [best];
      weak = weak.filter((p) => p !== best);
    }
    const weakSpend = weak.reduce((sum, p) => sum + (platforms.get(p)?.spend ?? 0), 0);
    const weakResults = weak.reduce((sum, p) => sum + (platforms.get(p)?.results ?? 0), 0);
    proposals.push({
      name: "update_adset_placements",
      args: { account_id: adset.account_id, adset_id: adset.id, publisher_platforms: remaining },
      rationale: `Stop running ${adset.name} on ${weak.map(platformLabel).join(" and ")}: ${money(weakSpend)} spent for ${plural(weakResults)}${
        weakResults > 0 ? ` (${money(weakSpend / weakResults)} each)` : ""
      } in ${input.period.label}, against ${money(average)} per result across the ad set.`,
    });
  }

  return {
    section: [
      `### Placements (${input.period.since} → ${input.period.until})`,
      ...(lines.length ? lines : ["- No placement data in this period and scope."]),
      ...(input.partial ? ["- More rows exist than were read, so these figures are partial."] : []),
    ].join("\n"),
    proposals,
  };
}
