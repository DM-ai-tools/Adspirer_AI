import type { Approval, ApprovalStatus, Client } from "@/types";
import {
  ApprovalExpiredError,
  BudgetCeilingViolation,
} from "@/lib/errors";
import { resolveBudgetDaily } from "@/lib/meta/resolve-budget-daily";

const EXECUTABLE_STATUSES: ApprovalStatus[] = ["approved", "edited"];

const REVIEW_TRANSITIONS: Record<ApprovalStatus, ApprovalStatus[]> = {
  pending: ["approved", "rejected", "edited", "cancelled"],
  edited: ["approved", "rejected", "cancelled", "executing"],
  approved: ["executing", "cancelled", "rejected"],
  rejected: [],
  executing: ["executed", "failed", "edited"],
  executed: [],
  failed: ["pending", "edited", "approved"],
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

  const daily =
    typeof args.daily_budget_cents === "number"
      ? args.daily_budget_cents
      : (() => {
          const budget = resolveBudgetDaily(args);
          return budget != null ? Math.round(budget * 100) : null;
        })();

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
