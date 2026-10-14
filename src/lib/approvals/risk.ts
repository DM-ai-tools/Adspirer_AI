import { resolveGoals, type GoalsProfile } from "@/lib/clients/goals";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export type RiskAssessment = { level: RiskLevel; reason: string };

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * How risky an approval is, from what it does to spend:
 *  - low: pauses and budget decreases;
 *  - medium: an increase within the client's max change, paused creates,
 *    resuming a single ad;
 *  - high: anything that restarts spend at campaign or ad set level, an
 *    increase above the max change, or an increase whose starting budget is
 *    unknown. High risk needs an admin to approve.
 */
export function assessRisk(
  toolName: string,
  args: Record<string, unknown>,
  client: { goals_profile?: GoalsProfile | null },
): RiskAssessment {
  const goals = resolveGoals(client);

  if (toolName.startsWith("pause_")) return { level: "low", reason: "Pausing stops spend." };

  if (toolName === "update_adset_budget" || toolName === "update_campaign_budget") {
    const next = num(args.daily_budget_cents);
    const prev = num(args.previous_daily_budget_cents);
    if (next != null && prev != null && next <= prev) {
      return { level: "low", reason: "Budget decrease." };
    }
    if (next == null || prev == null || prev <= 0) {
      return { level: "high", reason: "Budget increase from an unknown current budget." };
    }
    const pct = Math.round(((next - prev) / prev) * 100);
    return pct > goals.max_budget_change_pct
      ? {
          level: "high",
          reason: `Budget increase of ${pct}%, above the client's ${goals.max_budget_change_pct}% limit per approval.`,
        }
      : { level: "medium", reason: `Budget increase of ${pct}% (limit ${goals.max_budget_change_pct}%).` };
  }

  if (toolName === "resume_campaign" || toolName === "resume_adset") {
    return { level: "high", reason: "Resuming restarts spend." };
  }
  if (toolName === "resume_ad") {
    return { level: "medium", reason: "Resumes an ad inside its ad set's existing budget." };
  }

  if (toolName.startsWith("create_")) {
    return args.status === "ACTIVE"
      ? { level: "high", reason: "Creates a campaign that starts spending immediately." }
      : { level: "medium", reason: "Creates new entities, paused." };
  }

  return { level: "medium", reason: "Changes the ad account." };
}
