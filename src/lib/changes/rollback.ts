import type { Approval } from "@/types";
import { resolveProvider } from "@/lib/adspirer/client";
import { approve, createPendingApproval } from "@/lib/approvals/service";
import { executeApprovedAction } from "@/lib/approvals/executor";
import { readLiveState } from "@/lib/approvals/live-state";
import { getChange, listChanges, type ChangeLogEntry } from "@/lib/changes/change-log";
import { ApprovalValidationError, AuthorizationError } from "@/lib/errors";
import { humanToolLabel } from "@/lib/tools/display-labels";

const ID_FIELD = { campaign: "campaign_id", adset: "adset_id", ad: "ad_id" } as const;

/** The approval that undoes a change, or why it can't be undone in one action. */
export function inverseOf(change: ChangeLogEntry): { toolName: string; args: Record<string, unknown> } {
  const idArg = change.entity_id ? { [ID_FIELD[change.entity_type]]: change.entity_id } : {};
  const base = { account_id: change.account_id, ...idArg, __rollback_of: change.id };
  const isBudget = change.tool_name === "update_adset_budget" || change.tool_name === "update_campaign_budget";
  if (isBudget && change.before?.daily_budget_cents != null) {
    return {
      toolName: change.tool_name,
      args: { ...base, daily_budget_cents: change.before.daily_budget_cents },
    };
  }
  const status = /^(pause|resume)_(campaign|adset|ad)$/.exec(change.tool_name);
  if (status && change.before?.status) {
    const entity = status[2];
    return { toolName: `${status[1] === "pause" ? "resume" : "pause"}_${entity}`, args: base };
  }
  throw new ApprovalValidationError(
    "Only budget and status changes with a recorded before-state can be rolled back in one click. Undo this one in Ads Manager or ask for a new proposal.",
  );
}

/**
 * Undo a logged change: queue the inverse as an approval, approve it as
 * `userId` (so risk rules apply — undoing a pause restarts spend and needs
 * an admin) and run it. Refused when the item changed again in Meta since,
 * so a newer change is never overwritten.
 */
export async function rollbackChange(input: {
  changeId: string;
  userId: string;
}): Promise<{ approval: Approval; rolledBack: ChangeLogEntry }> {
  const change = await getChange(input.changeId);
  if (!change) throw new ApprovalValidationError(`Change ${input.changeId} was not found.`);
  if ((await listChanges(change.client_id, 500)).some((c) => c.rollback_of === change.id)) {
    throw new ApprovalValidationError("This change has already been rolled back.");
  }
  const { toolName, args } = inverseOf(change);

  const live = await readLiveState(await resolveProvider(), change.tool_name, args);
  if (!live) {
    throw new ApprovalValidationError(
      "CampaignForge couldn't read its current state from Meta, so it can't be rolled back safely right now. Try again shortly.",
    );
  }
  const changedSince =
    (change.after?.daily_budget_cents !== undefined && live.daily_budget_cents !== change.after.daily_budget_cents) ||
    (change.after?.status !== undefined && live.status !== change.after.status);
  if (changedSince) {
    throw new ApprovalValidationError(
      "This item changed again in Meta after this change, so rolling it back would overwrite a newer change. Roll back the newer change first, or ask for a new proposal.",
    );
  }

  const pending = await createPendingApproval({
    clientId: change.client_id,
    toolName,
    proposedArgs: args,
    rationale: `Roll back: ${humanToolLabel(change.tool_name)} on ${change.entity_type === "adset" ? "ad set" : change.entity_type} ${change.entity_id ?? ""} from ${change.created_at.slice(0, 10)}.`,
    requestedBy: input.userId,
  });
  try {
    await approve({ approvalId: pending.id, reviewedBy: input.userId });
  } catch (error) {
    if (error instanceof AuthorizationError) {
      throw new AuthorizationError(`${error.message} The rollback is waiting in Approvals.`);
    }
    throw error;
  }
  const { approval } = await executeApprovedAction({ approvalId: pending.id, executedBy: input.userId });
  return { approval, rolledBack: change };
}
