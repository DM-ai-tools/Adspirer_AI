import type { Approval, ApprovalStatus, Client } from "@/types";
import {
  ApprovalExpiredError,
  BudgetCeilingViolation,
} from "@/lib/errors";

const EXECUTABLE_STATUSES: ApprovalStatus[] = ["approved", "edited"];

const REVIEW_TRANSITIONS: Record<ApprovalStatus, ApprovalStatus[]> = {
  pending: ["approved", "rejected", "edited", "cancelled"],
  edited: ["approved", "rejected", "cancelled", "executing", "edited"],
  approved: ["executing", "cancelled", "rejected"],
  rejected: [],
  executing: ["executed", "failed", "edited"],
  executed: [],
  failed: ["pending", "edited", "approved", "rejected", "cancelled"],
  cancelled: [],
};

export function canTransition(
  from: ApprovalStatus,
  to: ApprovalStatus,
): boolean {
  return REVIEW_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(
  from: ApprovalStatus,
  to: ApprovalStatus,
): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid approval status transition: ${from} → ${to}`);
  }
}

export function assertApprovalNotExpired(approval: Approval): void {
  if (!approval.expires_at) return;
  if (new Date(approval.expires_at).getTime() < Date.now()) {
    throw new ApprovalExpiredError("Approval has expired", {
      approvalId: approval.id,
      expiresAt: approval.expires_at,
    });
  }
}

export function assertExecutableStatus(approval: Approval): void {
  if (!EXECUTABLE_STATUSES.includes(approval.status)) {
    throw new Error(
      `Approval ${approval.id} is not executable (status=${approval.status})`,
    );
  }
}

/**
 * Read a numeric arg that may arrive as a number or a numeric string. A value
 * that is present but not a finite number throws — it must never be treated
 * as "no budget" and skip the ceiling.
 */
function numericArg(args: Record<string, unknown>, key: string): number | null {
  const raw = args[key];
  if (raw == null || raw === "") return null;
  const n =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(raw)
        ? Number(raw)
        : Number.NaN;
  if (!Number.isFinite(n)) {
    throw new BudgetCeilingViolation(`${key} must be a number`, {
      [key]: raw,
    });
  }
  return n;
}

const MS_PER_DAY = 86_400_000;

/**
 * Effective daily spend in cents for the args (daily budget, or a lifetime
 * budget spread over its schedule). null when the args carry no budget.
 */
export function effectiveDailyBudgetCents(
  args: Record<string, unknown>,
): number | null {
  const dailyCents = numericArg(args, "daily_budget_cents");
  if (dailyCents != null) return Math.round(dailyCents);

  const daily =
    numericArg(args, "budget_daily") ?? numericArg(args, "daily_budget");
  if (daily != null) return Math.round(daily * 100);

  const lifetime = numericArg(args, "budget_lifetime");
  if (lifetime != null) {
    const end =
      typeof args.end_time === "string" ? Date.parse(args.end_time) : Number.NaN;
    const start =
      typeof args.start_time === "string"
        ? Date.parse(args.start_time)
        : Date.now();
    const days =
      Number.isFinite(end) && Number.isFinite(start) && end > start
        ? Math.max(1, Math.ceil((end - start) / MS_PER_DAY))
        : 1;
    return Math.ceil((lifetime * 100) / days);
  }
  return null;
}

/**
 * Budget impact (cents/day) derived from the final args — never trusted from
 * the client or the LLM, so an edit cannot understate it.
 */
export function computeBudgetImpactCents(
  toolName: string,
  args: Record<string, unknown>,
): number | null {
  if (toolName === "update_adset_budget") {
    const next = numericArg(args, "daily_budget_cents");
    if (next == null) return null;
    const prev = numericArg(args, "previous_daily_budget_cents") ?? 0;
    return Math.max(0, Math.round(next - prev));
  }
  if (
    toolName === "create_campaign" ||
    toolName === "create_meta_image_campaign" ||
    toolName === "create_meta_video_campaign" ||
    toolName === "create_adset"
  ) {
    return effectiveDailyBudgetCents(args);
  }
  return null;
}

/**
 * Budget ceiling check.
 * Uses effective daily budget or budget_impact_cents against client.budget_ceiling_cents.
 */
export function assertWithinBudgetCeiling(
  client: Pick<Client, "id" | "budget_ceiling_cents" | "currency">,
  args: Record<string, unknown>,
  budgetImpactCents?: number | null,
): void {
  const ceiling = client.budget_ceiling_cents;
  if (ceiling == null) return;

  const daily = effectiveDailyBudgetCents(args);

  if (daily != null && daily > ceiling) {
    throw new BudgetCeilingViolation(
      `Daily budget ${daily} exceeds client ceiling ${ceiling} cents`,
      {
        clientId: client.id,
        daily_budget_cents: daily,
        budget_ceiling_cents: ceiling,
        currency: client.currency,
      },
    );
  }

  if (budgetImpactCents != null && budgetImpactCents > ceiling) {
    throw new BudgetCeilingViolation(
      `Budget impact ${budgetImpactCents} exceeds client ceiling ${ceiling} cents`,
      {
        clientId: client.id,
        budget_impact_cents: budgetImpactCents,
        budget_ceiling_cents: ceiling,
      },
    );
  }
}

export function effectiveApprovalArgs(
  approval: Approval,
): Record<string, unknown> {
  return approval.edited_args ?? approval.proposed_args;
}
