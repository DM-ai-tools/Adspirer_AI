import { scopeAuditSnapshot, type MetaAuditSnapshot } from "@/lib/audit/meta-audit-data";
import {
  baselineOf,
  leversOf,
  proposeTargets,
  type GoalKind,
  type ProfitContext,
  type TargetOption,
} from "@/lib/strategy/account-strategy";

/**
 * One strategy section per campaign: each campaign's own numbers, ad sets, waste and winners, and its
 * own three targets, worked out with the same engine as the account strategy on that campaign alone.
 * The writer turns each block into a section of the plan; every figure is computed here.
 */

type Money = (cents: number) => string;

/** Campaigns that took at least this share of the period's spend get their own section (at most MAX). */
const MIN_SHARE = 0.03;
const MAX_CAMPAIGNS = 8;

export type CampaignPlanInput = {
  snapshot: MetaAuditSnapshot;
  kind: GoalKind;
  profit: ProfitContext;
  money: Money;
  /** The option the operator picked for the account; each campaign shows its own figure for the same option. */
  pick?: TargetOption["key"] | null;
};

const x = (n: number) => `${n.toFixed(2)}×`;

/** The campaigns worth a section: the period's spenders, largest first. */
export function campaignsToBreakDown(snapshot: MetaAuditSnapshot): MetaAuditSnapshot["campaigns"] {
  const total = snapshot.campaigns.reduce((s, c) => s + (c.performance?.spendCents ?? 0), 0);
  if (total <= 0) return [];
  return snapshot.campaigns
    .filter((c) => (c.performance?.spendCents ?? 0) / total >= MIN_SHARE)
    .sort((a, b) => (b.performance?.spendCents ?? 0) - (a.performance?.spendCents ?? 0))
    .slice(0, MAX_CAMPAIGNS);
}

export function renderCampaignBreakdownEvidence(input: CampaignPlanInput): string {
  const { snapshot, kind, profit, money } = input;
  const unit = kind === "sales" ? "purchase" : kind === "leads" ? "lead" : "result";
  const campaigns = campaignsToBreakDown(snapshot);
  const total = snapshot.campaigns.reduce((s, c) => s + (c.performance?.spendCents ?? 0), 0);
  const lines = [
    "### Campaign breakdown (one section per campaign, as the operator asked)",
    `- ${campaigns.length} campaign${campaigns.length === 1 ? "" : "s"} took ${Math.round(MIN_SHARE * 100)}% or more of the period's spend; each gets its own section below. Figures are each campaign's own, for the same period as the account.`,
  ];
  if (!campaigns.length) {
    lines.push("- No campaign spent in the period, so there is nothing to break down.");
    return lines.join("\n");
  }
  for (const c of campaigns) {
    const scoped = scopeAuditSnapshot(snapshot, [c.id]);
    const baseline = baselineOf(scoped, kind);
    const share = Math.round(((c.performance?.spendCents ?? 0) / total) * 100);
    const adSets = scoped.adSets;
    const live = adSets.filter((a) => a.status === "ACTIVE");
    const liveAds = scoped.ads.filter((a) => a.status === "ACTIVE").length;
    lines.push("", `#### Campaign: ${c.name}`);
    lines.push(`- Objective: ${c.objective.replace(/^OUTCOME_/, "").toLowerCase()} · status ${c.status.toLowerCase()} · ${share}% of the account's spend`);
    if (!baseline) {
      lines.push(`- No delivery in the period: no figures to plan from. Decide whether it should run at all.`);
      continue;
    }
    lines.push(
      `- Now: ${money(baseline.spendPerDayCents)}/day · ${baseline.conversions} ${unit}s (${baseline.conversionsPerDay.toFixed(1)}/day) · ` +
        `${baseline.costPerCents != null ? `${money(baseline.costPerCents)} per ${unit}` : `no ${unit}s`}` +
        `${kind === "sales" && baseline.roas != null ? ` · ROAS ${x(baseline.roas)}` : ""}` +
        `${baseline.conversions < 15 ? " · under 15 results: directional only" : ""}`,
    );
    lines.push(
      `- Ad sets: ${adSets.length} (${live.length} live; ${adSets.filter((a) => a.learningStatus === "FAIL" || a.learningStatus === "LEARNING_LIMITED").length} learning limited) · live ads: ${liveAds}`,
    );
    const levers = leversOf(scoped, kind, baseline);
    if (levers.waste.length) {
      lines.push(
        `- Waste: ${levers.waste.map((w) => `${w.name} (${money(w.spendCents)} spent, ${w.conversions} ${unit}s${w.costPerCents != null ? `, ${money(w.costPerCents)} each` : ""})`).join("; ")}`,
      );
    } else lines.push("- Waste: no ad set costs twice the campaign's own average.");
    if (levers.winners.length) {
      lines.push(
        `- Best ad sets: ${levers.winners.map((w) => `${w.name} (${w.costPerCents != null ? `${money(w.costPerCents)} per ${unit}` : "n/a"}${w.roas != null ? `, ROAS ${x(w.roas)}` : ""}, ${w.conversions} ${unit}s)`).join("; ")}`,
      );
    }
    const options = proposeTargets(kind, baseline, levers, profit);
    if (options.length) {
      lines.push(`| Option | ${unit}s/day | Budget/day | Cost per ${unit} |${kind === "sales" ? " ROAS |" : ""} By (days) |`);
      lines.push(`|---|---|---|---|${kind === "sales" ? "---|" : ""}---|`);
      for (const o of options) {
        const picked = input.pick === o.key ? " (the account's pick)" : "";
        lines.push(
          `| ${o.key}${picked} | ${o.conversionsPerDay != null ? o.conversionsPerDay.toFixed(1) : "as now"} | ${o.dailyBudgetCents != null ? money(o.dailyBudgetCents) : money(baseline.spendPerDayCents)} | ${o.costPerCents != null ? money(o.costPerCents) : "n/a"} |${kind === "sales" ? ` ${o.roas != null ? x(o.roas) : "n/a"} |` : ""} ${o.windowDays} |`,
        );
      }
    } else lines.push(`- No targets: the campaign recorded no ${unit}s, so the first milestone is getting some.`);
  }
  return lines.join("\n");
}
