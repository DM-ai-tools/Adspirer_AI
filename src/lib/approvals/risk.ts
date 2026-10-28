import { resolveGoals, type GoalsProfile } from "@/lib/clients/goals";
import { metaTimeMs } from "@/lib/meta/adset-edits";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export type RiskAssessment = { level: RiskLevel; reason: string };

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A cap raised, or a ROAS floor lowered, by more than this much of its current value needs an admin. */
const BID_RAISE_LIMIT = 0.25;

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
  context: { projectedAccountDailyCents?: number | null } = {},
): RiskAssessment {
  const goals = resolveGoals(client);

  // Over the daily cap: execution will refuse it whoever approves.
  const projected = context.projectedAccountDailyCents;
  if (goals.daily_account_cap_cents && projected != null && projected > goals.daily_account_cap_cents) {
    return {
      level: "high",
      reason: "Would take the account's live daily budgets over the client's daily cap; it will be blocked unless another budget is lowered or the cap raised.",
    };
  }

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
    const exact = ((next - prev) / prev) * 100;
    const pct = Math.round(exact);
    return exact > goals.max_budget_change_pct
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

  if (toolName === "update_adset_audience_exclusions") {
    return {
      level: "medium",
      reason: "Changes who can see the ads (audience exclusions). It narrows or widens the audience and may restart learning; no extra spend is added.",
    };
  }

  if (toolName === "update_adset_placements") {
    return {
      level: "medium",
      reason: "Changes where the ads run. Narrowing placements can limit delivery and may restart learning; no extra spend is added.",
    };
  }

  if (toolName === "update_adset_bid") {
    if (args.bid_strategy === "LOWEST_COST_WITHOUT_CAP") {
      const before = args.__before as { bid_strategy?: string | null } | undefined;
      const wasUncapped = before && "bid_strategy" in before && before.bid_strategy === "LOWEST_COST_WITHOUT_CAP";
      if (!wasUncapped) {
        return {
          level: "high",
          reason: "Removes the cost control (or its current setting could not be read), so the ad set can spend its budget at any cost per result. Meta restarts the learning phase after a bid change.",
        };
      }
    }
    // A cap is a ceiling on what a result may cost: a big raise lets the ad set pay much more per result.
    const before = args.__before as
      | { bid_strategy?: string | null; bid_amount_cents?: number | null; roas_average_floor?: number | null }
      | undefined;
    if (before && before.bid_strategy === args.bid_strategy) {
      const nextCap = num(args.bid_amount);
      const wasCap = num(before.bid_amount_cents);
      if (nextCap != null && wasCap != null && wasCap > 0) {
        const raise = (nextCap * 100 - wasCap) / wasCap;
        if (raise > BID_RAISE_LIMIT) {
          return {
            level: "high",
            reason: `Raises the cap by ${Math.round(raise * 100)}%, so the ad set can pay that much more per result. Meta restarts the learning phase after a bid change.`,
          };
        }
      }
      const nextFloor = num(args.roas_average_floor);
      const wasFloor = num(before.roas_average_floor);
      if (nextFloor != null && wasFloor != null && wasFloor > 0) {
        const drop = (wasFloor - nextFloor) / wasFloor;
        if (drop > BID_RAISE_LIMIT) {
          return {
            level: "high",
            reason: `Lowers the minimum ROAS by ${Math.round(drop * 100)}%, so the ad set will accept much weaker returns. Meta restarts the learning phase after a bid change.`,
          };
        }
      }
    }
    return { level: "medium", reason: "Changes how the ad set bids. Meta restarts the learning phase after a bid change." };
  }

  if (toolName === "update_adset_schedule") {
    if (args.clear_end_time === true) {
      return { level: "medium", reason: "Removes the end date, so the ad set keeps spending until it is paused." };
    }
    if (typeof args.end_time === "string") {
      const before = args.__before as { end_time?: string | null } | undefined;
      if (!before || !("end_time" in before)) {
        return { level: "medium", reason: "Changes when the ad set stops spending (its current end date could not be read)." };
      }
      const was = metaTimeMs(before.end_time ?? null);
      const next = metaTimeMs(args.end_time);
      if (was == null) return { level: "low", reason: "Adds an end date, so the ad set stops spending sooner." };
      if (next != null && next < was) return { level: "low", reason: "Ends the ad set sooner." };
      return { level: "medium", reason: "Extends the ad set, so it keeps spending for longer." };
    }
    return { level: "medium", reason: "Moves when the ad set starts spending." };
  }

  if (toolName.startsWith("create_")) {
    return args.status === "ACTIVE"
      ? { level: "high", reason: "Creates a campaign that starts spending immediately." }
      : { level: "medium", reason: "Creates new entities, paused." };
  }

  return { level: "medium", reason: "Changes the ad account." };
}
