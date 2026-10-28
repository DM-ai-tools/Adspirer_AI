import type { Approval } from "@/types";
import { resolveProvider } from "@/lib/adspirer/client";
import { approve, createPendingApproval } from "@/lib/approvals/service";
import { executeApprovedAction } from "@/lib/approvals/executor";
import { changedSince, readLiveState } from "@/lib/approvals/live-state";
import { getChange, listChanges, type ChangeLogEntry } from "@/lib/changes/change-log";
import { ApprovalValidationError, AuthorizationError, DuplicateExecutionError } from "@/lib/errors";
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
  if (
    change.tool_name === "update_adset_audience_exclusions" &&
    change.before?.excluded_custom_audiences &&
    change.after?.excluded_custom_audiences
  ) {
    const was = change.before.excluded_custom_audiences;
    const now = change.after.excluded_custom_audiences;
    const add = was.filter((id) => !now.includes(id));
    const remove = now.filter((id) => !was.includes(id));
    if (add.length || remove.length) {
      return {
        toolName: change.tool_name,
        args: {
          ...base,
          ...(add.length ? { add_excluded_custom_audiences: add } : {}),
          ...(remove.length ? { remove_excluded_custom_audiences: remove } : {}),
        },
      };
    }
  }
  if (change.tool_name === "update_adset_placements" && change.before?.placements) {
    const was = change.before.placements;
    if (!was.publisher_platforms) return { toolName: change.tool_name, args: { ...base, advantage_placements: true } };
    // A platform that had no positions set ran on all of them: an empty list puts that back, so
    // positions the change added don't linger.
    const positions: Record<string, string[]> = {};
    for (const platform of was.publisher_platforms) {
      const key = `${platform}_positions`;
      if (!["facebook_positions", "instagram_positions", "audience_network_positions", "messenger_positions"].includes(key)) continue;
      positions[key] = (was as Record<string, string[] | null | undefined>)[key] ?? [];
    }
    return {
      toolName: change.tool_name,
      args: {
        ...base,
        publisher_platforms: was.publisher_platforms,
        ...positions,
        // An empty list clears a device restriction the change added.
        device_platforms: was.device_platforms ?? [],
      },
    };
  }
  if (change.tool_name === "update_adset_bid" && change.before?.bid_strategy) {
    const was = change.before;
    return {
      toolName: change.tool_name,
      args: {
        ...base,
        bid_strategy: was.bid_strategy,
        ...(was.bid_amount_cents != null ? { bid_amount: was.bid_amount_cents / 100 } : {}),
        ...(was.roas_average_floor != null ? { roas_average_floor: was.roas_average_floor } : {}),
      },
    };
  }
  if (change.tool_name === "update_adset_schedule" && change.before) {
    const was = change.before;
    return {
      toolName: change.tool_name,
      args: {
        ...base,
        ...(was.end_time ? { end_time: was.end_time } : { clear_end_time: true }),
      },
    };
  }
  const status = /^(pause|resume)_(campaign|adset|ad)$/.exec(change.tool_name);
  if (status && change.before?.status) {
    const entity = status[2];
    return { toolName: `${status[1] === "pause" ? "resume" : "pause"}_${entity}`, args: base };
  }
  throw new ApprovalValidationError(
    "Only budget, status, schedule, bid, placement and audience exclusion changes with a recorded before-state can be rolled back in one click. Undo this one in Ads Manager or ask for a new proposal.",
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
  if (changedSince(change.after, live)) {
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
  // A second click reuses the same approval; if the first click already took
  // it past review, say so instead of failing on a status transition.
  if (pending.status !== "pending" && pending.status !== "edited") {
    throw new ApprovalValidationError("This rollback is already in progress.");
  }
  try {
    await approve({ approvalId: pending.id, reviewedBy: input.userId });
    const { approval } = await executeApprovedAction({ approvalId: pending.id, executedBy: input.userId });
    return { approval, rolledBack: change };
  } catch (error) {
    if (error instanceof AuthorizationError) {
      throw new AuthorizationError(`${error.message} The rollback is waiting in Approvals.`);
    }
    if (error instanceof DuplicateExecutionError) {
      throw new ApprovalValidationError("This rollback is already in progress.");
    }
    throw error;
  }
}
