/**
 * The account-strategy figures as evidence for the writer. Facts and worked numbers only: the
 * wording and the advice are the writer's (see account-strategy-framework.ts).
 */
import type { MetaAuditSnapshot } from "@/lib/audit/meta-audit-data";
import { moneyFor } from "@/lib/audit/render";
import {
  budgetForVolume,
  marginNeeded,
  judgeTarget,
  type AccountGoal,
  type AdSetRead,
  type Baseline,
  type Levers,
  type StatedTarget,
  type TargetOption,
  type TargetVerdict,
} from "@/lib/strategy/account-strategy";

const x = (n: number | null | undefined) => (n == null ? "n/a" : `${n.toFixed(2)}×`);
const pct = (from: number, to: number) => {
  if (from === 0) return "n/a";
  const p = Math.round(((to - from) / from) * 100);
  return `${p > 0 ? "+" : p < 0 ? "−" : ""}${Math.abs(p)}%`;
};

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export type StrategyEvidenceInput = {
  snapshot: MetaAuditSnapshot;
  goal: AccountGoal;
  baseline: Baseline | null;
  levers: Levers | null;
  /** Where the period came from: "the audit in this chat", "the operator's ask", "the last 30 days". */
  periodSource: string;
  /** The client's saved target, if any (cost per result in cents, or ROAS). */
  savedTarget?: { roas?: number | null; costPerCents?: number | null };
  /** Today, YYYY-MM-DD, for the target date. */
  today: string;
  /** The client's gross margin, when set. */
  marginPct?: number | null;
};

/** The ad-set reads a strategy can't do without; when one failed, the waste and winners are unknown, not absent. */
export function adSetLoadFailure(snapshot: MetaAuditSnapshot): string | null {
  const failed = snapshot.warnings.filter((w) => /^(Campaigns|Ad sets|Ad set performance):/.test(w));
  return failed.length ? failed.join("; ") : null;
}

function header(input: StrategyEvidenceInput): string[] {
  const { snapshot, goal } = input;
  const unit = goal.unit;
  const lines = [
    `### Account strategy — ${snapshot.account.name} (live Meta data, ${snapshot.account.currency})`,
    `- Period read: ${snapshot.period.since} → ${snapshot.period.until} (${snapshot.period.days} days; ${input.periodSource}).`,
    `- What the account is run for: **${goal.kind === "sales" ? "sales" : goal.kind === "leads" ? "leads" : unit + "s"}** (from ${goal.basis}). The unit to plan on is **cost per ${unit}**.`,
  ];
  if (goal.kind !== "sales") {
    lines.push(`- This is not a sales account: never mention ROAS, revenue or return on ad spend, and never ask for a ROAS target. Plan on cost per ${unit} and the number of ${unit}s.`);
  }
  return lines;
}

function baselineLines(input: StrategyEvidenceInput): string[] {
  const { baseline: b, goal } = input;
  const money = moneyFor(input.snapshot.account.currency);
  if (!b) return ["- Totals for the period could not be loaded: say so, and give no target or projection."];
  const lines = [
    "",
    "**Where it stands (whole period)**",
    `- Spend: ${money(b.spendPerDayCents)}/day.`,
    `- ${goal.unit}s: ${b.conversions} (${b.conversionsPerDay.toFixed(1)}/day).`,
    `- Cost per ${goal.unit}: ${b.costPerCents != null ? money(b.costPerCents) : `no ${goal.unit}s recorded, so no cost per ${goal.unit}`}.`,
  ];
  if (goal.kind === "sales") {
    lines.push(`- ROAS (Meta-reported): ${x(b.roas)}; revenue ${b.revenuePerDayCents != null ? `${money(b.revenuePerDayCents)}/day` : "not reported"}.`);
    if (b.roas != null && b.roas > 0) {
      lines.push(`- Break-even: at ${x(b.roas)} the ads make money at any gross margin above ${Math.ceil(marginNeeded(b.roas) * 100)}% (1 ÷ ROAS)${input.marginPct != null ? `; the client's margin is ${input.marginPct}%` : "; the client's margin isn't set"}.`);
    }
  }
  return lines;
}

function adSetLine(r: AdSetRead, unit: string, money: (c: number) => string, sales: boolean): string {
  return `  - "${r.name}" [${r.status}${r.learningLimited ? ", learning limited" : ""}] — spend ${money(r.spendCents)}, ${r.conversions} ${unit}s${r.costPerCents != null ? ` at ${money(r.costPerCents)} each` : ""}${sales && r.roas != null ? `, ROAS ${x(r.roas)}` : ""}${r.frequency7d != null ? `, 7-day frequency ${r.frequency7d.toFixed(2)}` : ""}`;
}

function leverLines(input: StrategyEvidenceInput): string[] {
  const { levers: l, baseline: b, goal } = input;
  if (!l || !b) return [];
  const money = moneyFor(input.snapshot.account.currency);
  const sales = goal.kind === "sales";
  const unit = goal.unit;
  const lines = ["", "**Where the money works and where it doesn't (ad sets, whole period)**"];
  const failure = adSetLoadFailure(input.snapshot);
  if (failure) {
    lines.push(
      `- The ad sets failed to load from Meta (${failure}). Which ad sets waste money and which work is UNKNOWN, not absent: never say there is no waste or no winner, and propose no target or plan from the ad sets. Say Meta didn't return them and to try again in a few minutes.`,
    );
    return lines;
  }
  if (b.costPerCents == null) {
    lines.push(`- No ${unit}s in the period, so no ad set can be called a winner or a waste. The first job is to get ${unit}s recorded (tracking, the optimisation event, enough budget per ad set).`);
    return lines;
  }
  if (l.waste.length) {
    lines.push(
      `- Wasting (cost per ${unit} at least 2× the account's ${money(b.costPerCents)}, or that much spent for none): ${money(l.wasteSpendCents)} in the period, ${Math.round((l.wasteSpendCents / (b.spendPerDayCents * b.days)) * 100)}% of spend.`,
      ...l.waste.slice(0, 8).map((r) => adSetLine(r, unit, money, sales)),
    );
  } else {
    lines.push(`- No ad set costs 2× the account average or more: there is no clear waste to cut.`);
  }
  if (l.otherGoal.length) {
    // Worked here so the writer never has to reason which way the split moves the cost.
    const otherSpend = l.otherGoal.reduce((sum, r) => sum + r.spendCents, 0);
    const otherConv = l.otherGoal.reduce((sum, r) => sum + r.conversions, 0);
    const aimedSpend = b.spendPerDayCents * b.days - otherSpend;
    const aimedConv = b.conversions - otherConv;
    if (aimedSpend > 0 && aimedConv > 0) {
      lines.push(
        `- Spend aimed at ${unit}s only: ${money(aimedSpend)} for ${aimedConv} ${unit}s = ${money(Math.round(aimedSpend / aimedConv))} per ${unit} (${Math.round(aimedSpend / aimedConv) <= (b.costPerCents ?? 0) ? "lower" : "higher"} than the account's ${money(b.costPerCents)}, since ${money(otherSpend)} went to ad sets optimised for something else). Quote this figure; don't reason it out yourself.`,
      );
    }
    lines.push(
      `- Optimised for a different result, so NOT judged on ${unit}s (never call these waste for having no ${unit}s; judge each on its own result, and ask whether it belongs in a ${unit} plan):`,
      ...l.otherGoal.slice(0, 6).map((r) => `  - "${r.name}" [${r.status}] — goal ${r.optimizationGoal ?? "unknown"}, spend ${money(r.spendCents)}, ${r.ownResults ?? "n/a"} ${r.ownResultLabel.toLowerCase() || "results"}${r.conversions ? `, ${r.conversions} ${unit}s` : ""}`),
    );
  }
  if (l.stoppedWaste.length) {
    lines.push(`- Already off (wasted money in the period but no longer running, so no saving left to make):`, ...l.stoppedWaste.slice(0, 5).map((r) => adSetLine(r, unit, money, sales)));
  }
  if (l.winners.length) {
    lines.push(`- Beating the account by 20%+ on 5+ ${unit}s:`, ...l.winners.slice(0, 6).map((r) => adSetLine(r, unit, money, sales)));
  } else {
    lines.push(`- No ad set beats the account by 20% on 5+ ${unit}s: no proven winner to move budget to.`);
  }
  lines.push(
    "",
    "**Worked projections (same total spend; Meta's own figures; projections, not promises)**",
    `- If the wasting ad sets stop and their budget goes to the rest at the rest's own cost: cost per ${unit} ${l.costWithoutWasteCents != null ? `${money(l.costWithoutWasteCents)} (${pct(b.costPerCents, l.costWithoutWasteCents)})` : "n/a"}${sales ? `, ROAS ${x(l.roasWithoutWaste)}` : ""}.`,
    `- If that budget goes to the winners instead, at a cost 30% worse than they get today (scaling costs more): cost per ${unit} ${l.costWithShiftCents != null ? `${money(l.costWithShiftCents)} (${pct(b.costPerCents, l.costWithShiftCents)})` : "n/a"}${sales ? `, ROAS ${x(l.roasWithShift)}` : ""}.`,
  );
  if (l.costWithShiftCents != null && l.costWithoutWasteCents != null && l.winners.length && l.costWithShiftCents > l.costWithoutWasteCents) {
    lines.push(`- Moving that budget to the winners alone does worse than spreading it across the rest: once their cost rises with scale, the winners aren't cheap enough. Don't plan to pour budget into one ad set.`);
  }
  if (l.thinData) {
    lines.push(`- Only ${b.conversions} ${unit}s in the period: every projection here is directional. Say so once, near the top.`);
  }
  return lines;
}

function savedTargetLine(input: StrategyEvidenceInput): string[] {
  const s = input.savedTarget;
  if (!s) return [];
  const money = moneyFor(input.snapshot.account.currency);
  const parts = [
    input.goal.kind === "sales" && s.roas != null ? `ROAS ${x(s.roas)}` : null,
    s.costPerCents != null ? `cost per ${input.goal.unit} ${money(s.costPerCents)}` : null,
  ].filter(Boolean);
  return parts.length ? [`- The client's saved target (Goals): ${parts.join(", ")}.`] : [];
}

/** Evidence for the first turn: the analysis and three targets to choose from. No plan. */
export function renderTargetProposalEvidence(input: StrategyEvidenceInput & { options: TargetOption[]; windowDays?: number }): string {
  const money = moneyFor(input.snapshot.account.currency);
  const unit = input.goal.unit;
  const lines = [...header(input), ...baselineLines(input), ...leverLines(input), "", "**Targets this account's numbers support**"];
  if (adSetLoadFailure(input.snapshot)) {
    lines.push("- None: the ad sets didn't load, so no target can be set honestly. Say so and ask them to try again in a few minutes.");
  } else if (!input.options.length) {
    lines.push(`- None: without ${unit}s there is no cost to improve on. Propose the first milestone instead (get ${unit}s recorded and at least 10 a week), and what has to change to get there.`);
  } else if (input.options[0]!.mode === "scale") {
    const sales = input.goal.kind === "sales";
    lines.push(
      `- This account already makes money comfortably, so the limit is volume, not cost: these are **scale** targets (more ${unit}s on a bigger budget, with a ceiling on what each may cost). Cutting any waste still belongs in the plan.`,
      `| Option | ${unit}s/day (now ${input.baseline!.conversionsPerDay.toFixed(1)}) | Budget/day (now ${money(input.baseline!.spendPerDayCents)}) | Max cost per ${unit} |${sales ? " Min ROAS |" : ""} By (days) | Rests on |`,
      `|---|---|---|---|${sales ? "---|" : ""}---|---|`,
      ...input.options.map((o) => {
        const days = input.windowDays ?? o.windowDays;
        return `| ${o.key} | ${o.conversionsPerDay ?? "n/a"} | ${o.dailyBudgetCents != null ? money(o.dailyBudgetCents) : "n/a"} | ${o.costPerCents != null ? money(o.costPerCents) : "n/a"} |${sales ? ` ${x(o.roas)} |` : ""} ${days} (by ${addDays(input.today, days)}) | ${o.basis} |`;
      }),
    );
    if (input.windowDays != null) lines.push(`- The operator asked for ${input.windowDays} days, so every option uses that window.`);
  } else {
    lines.push(
      `| Option | Cost per ${unit} |${input.goal.kind === "sales" ? " ROAS |" : ""} By (days) | Rests on |`,
      `|---|---|${input.goal.kind === "sales" ? "---|" : ""}---|---|`,
      ...input.options.map((o) => {
        const days = input.windowDays ?? o.windowDays;
        return `| ${o.key} | ${o.costPerCents != null ? money(o.costPerCents) : "n/a"} |${input.goal.kind === "sales" ? ` ${x(o.roas)} |` : ""} ${days} (by ${addDays(input.today, days)}) | ${o.basis} |`;
      }),
    );
    if (input.windowDays != null) lines.push(`- The operator asked for ${input.windowDays} days, so every option uses that window.`);
  }
  lines.push(...savedTargetLine(input));
  return lines.join("\n");
}

const VERDICT_TEXT: Record<TargetVerdict, string> = {
  already_met: "already met today: the plan is to hold it while growing volume",
  reachable: "reachable by stopping the waste alone",
  stretch: "reachable only if the waste budget moves to the winners and they hold up as they scale",
  beyond_the_data: "beyond what this account's own numbers support: it needs changes whose effect can't be projected (offer, landing page, new creative). Say that plainly and give the nearest target the numbers do support",
  unknown: "can't be checked against the numbers (see the lines above)",
};

/** Evidence for the plan turn: the analysis, the chosen target and how it compares. */
export function renderStrategyPlanEvidence(
  input: StrategyEvidenceInput & { target: StatedTarget; targetSource: string; defaultWindowDays: number },
): string {
  const { baseline: b, levers: l, goal, target } = input;
  const money = moneyFor(input.snapshot.account.currency);
  const unit = goal.unit;
  const windowDays = target.windowDays ?? input.defaultWindowDays;
  const lines = [...header(input), ...baselineLines(input), ...leverLines(input), "", "**The target**"];
  if (target.scale && b) {
    const perDay = target.volume != null ? target.volume / windowDays : null;
    lines.push(
      `- **Scale target** (${input.targetSource}): ${perDay != null ? `${perDay.toFixed(1)} ${unit}s/day (now ${b.conversionsPerDay.toFixed(1)}), ${target.volume} in ${windowDays} days` : "more volume"} by ${addDays(input.today, windowDays)}, on ${money(target.scale.dailyBudgetCents)}/day (now ${money(b.spendPerDayCents)}/day, ${pct(b.spendPerDayCents, target.scale.dailyBudgetCents)}).`,
      `- Limits while scaling: cost per ${unit} stays under ${target.costPerCents != null ? money(target.costPerCents) : "n/a"}${goal.kind === "sales" && target.roas != null ? ` and ROAS above ${x(target.roas)}` : ""}. These are ceilings, not costs to reach: today's cost per ${unit} is ${b.costPerCents != null ? money(b.costPerCents) : "n/a"}.`,
      `- The budget gets there in 20–30% steps every 3–4 days, each step only when the last 3–4 days stayed under the limit. Give the steps with dates.`,
      `- On track looks like: ${unit}s per day rising each week while cost per ${unit} stays under the limit; if a step breaks the limit, hold the budget for a week, and fix creative before the next step.`,
    );
    if (windowDays < 14) lines.push(`- ${windowDays} days is too short to scale safely: say so.`);
    if (l?.waste.length) lines.push(`- Stop the waste first (see above): it is budget the scale-up can use.`);
    lines.push(...savedTargetLine(input));
    return lines.join("\n");
  }
  const parts = [
    target.roas != null ? `ROAS ${x(target.roas)}` : null,
    target.costPerCents != null ? `cost per ${unit} ${money(target.costPerCents)}` : null,
    target.volume != null ? `${target.volume} ${unit}s` : null,
  ].filter(Boolean);
  lines.push(
    `- ${parts.join(", ")} within ${windowDays} days (by ${addDays(input.today, windowDays)}) — ${input.targetSource}${target.windowDays == null ? `; no time was given, so ${windowDays} days was used: say so` : ""}.`,
  );
  if (windowDays < 14) {
    lines.push(`- ${windowDays} days is shorter than one learning cycle plus a week of results: say the target can't be judged that fast, and give the date it can be.`);
  }
  if (b && l) {
    lines.push(`- Verdict: ${VERDICT_TEXT[judgeTarget(target, b, l)]}.`);
    if (target.costPerCents != null && b.costPerCents != null) {
      lines.push(`- Gap: cost per ${unit} ${money(b.costPerCents)} now → ${money(target.costPerCents)} (${pct(b.costPerCents, target.costPerCents)}).`);
    }
    if (target.roas != null && b.roas != null) lines.push(`- Gap: ROAS ${x(b.roas)} now → ${x(target.roas)} (${pct(b.roas, target.roas)}).`);
    if (target.volume != null) {
      const cost = target.costPerCents ?? l.costWithoutWasteCents ?? b.costPerCents;
      const atNow = b.conversionsPerDay * windowDays;
      lines.push(`- Volume: ${target.volume} ${unit}s in ${windowDays} days is ${(target.volume / windowDays).toFixed(1)}/day; today's pace gives ${Math.round(atNow)}.`);
      if (cost != null) {
        const daily = budgetForVolume(target.volume, windowDays, cost);
        lines.push(
          `- Budget that volume needs at ${money(cost)} per ${unit}: ${money(daily)}/day (now ${money(b.spendPerDayCents)}/day, ${pct(b.spendPerDayCents, daily)}). Cost per ${unit} usually rises as budget grows, so treat it as the floor.`,
        );
      }
    }
    // Halfway by the middle of the window, the target by its end: what "on track" looks like each week.
    const goalCost = target.costPerCents ?? null;
    if (goalCost != null && b.costPerCents != null && windowDays >= 14) {
      const mid = Math.round((b.costPerCents + goalCost) / 2);
      lines.push(`- On track looks like: about ${money(mid)} per ${unit} by day ${Math.round(windowDays / 2)}, ${money(goalCost)} by day ${windowDays}. Week 1 is for the fixes; don't expect the figure to move yet.`);
    }
  }
  lines.push(...savedTargetLine(input));
  return lines.join("\n");
}
