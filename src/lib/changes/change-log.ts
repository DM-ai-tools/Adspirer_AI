import { nanoid } from "nanoid";
import type { Approval } from "@/types";
import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { newEntityId } from "@/lib/db/live-maps";
import { nowIso } from "@/lib/utils";

/**
 * One executed change to Meta: what it touched, its state before and after,
 * who approved and who ran it, and why. Append-only — entries are never
 * edited or deleted; a rollback is a new entry pointing at the one it undoes.
 */
export type ChangeState = { daily_budget_cents?: number | null; status?: string };

export type ChangeLogEntry = {
  id: string;
  client_id: string;
  approval_id: string;
  tool_name: string;
  account_id: string | null;
  entity_type: "campaign" | "adset" | "ad";
  entity_id: string | null;
  before: ChangeState | null;
  after: ChangeState | null;
  approved_by: string | null;
  executed_by: string | null;
  rationale: string | null;
  /** The change this one rolled back. */
  rollback_of: string | null;
  created_at: string;
};

const str = (v: unknown) => (typeof v === "string" && v ? v : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function entityTypeOf(toolName: string): ChangeLogEntry["entity_type"] {
  if (/adset|ad_set/.test(toolName)) return "adset";
  if (/_ad$|create_ad$/.test(toolName)) return "ad";
  return "campaign";
}

/** The log entry for an approval that just executed. */
export function buildChangeEntry(
  approval: Approval,
  executionResult: Record<string, unknown>,
  executedBy: string | null,
): Omit<ChangeLogEntry, "id" | "created_at"> {
  const args = approval.edited_args ?? approval.proposed_args;
  const proof = (executionResult.proof ?? {}) as Record<string, unknown>;
  const tool = approval.tool_name;
  const entityType = entityTypeOf(tool);
  const entityId =
    entityType === "adset"
      ? (str(proof.ad_set_id) ?? str(args.adset_id) ?? str(args.ad_set_id))
      : entityType === "ad"
        ? (str(proof.ad_id) ?? str(args.ad_id))
        : (str(proof.campaign_id) ?? str(args.campaign_id));
  const isBudget = tool === "update_adset_budget" || tool === "update_campaign_budget";
  const isStatus = /^(pause|resume)_/.test(tool);
  const liveBefore = (args.__before ?? null) as ChangeState | null;

  let before: ChangeState | null = null;
  let after: ChangeState | null = null;
  if (isBudget) {
    const was = liveBefore?.daily_budget_cents ?? num(args.previous_daily_budget_cents);
    before = was != null ? { daily_budget_cents: was } : null;
    after = { daily_budget_cents: num(proof.daily_budget_cents) ?? num(args.daily_budget_cents) };
  } else if (isStatus) {
    before = liveBefore?.status ? { status: liveBefore.status } : null;
    after = { status: str(proof.status) ?? (tool.startsWith("pause_") ? "PAUSED" : "ACTIVE") };
  } else {
    after = str(proof.status) ? { status: String(proof.status) } : null;
  }

  return {
    client_id: approval.client_id,
    approval_id: approval.id,
    tool_name: tool,
    account_id: str(executionResult.account_id) ?? str(args.account_id),
    entity_type: entityType,
    entity_id: entityId,
    before,
    after,
    approved_by: approval.reviewed_by ?? null,
    executed_by: executedBy,
    rationale: approval.rationale ?? null,
    rollback_of: str(args.__rollback_of),
  };
}

/** Append an entry. */
export async function recordChange(entry: Omit<ChangeLogEntry, "id" | "created_at">): Promise<ChangeLogEntry> {
  const config = getConfig();
  const full: ChangeLogEntry = {
    ...entry,
    id: config.isDemoMode || !config.hasSupabase ? `change_${nanoid(10)}` : newEntityId(),
    created_at: nowIso(),
  };
  if (config.isDemoMode || !config.hasSupabase) {
    getDemoStore().changeLog.push(full);
    return full;
  }
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { error } = await createAdminClient().from("change_log").insert(full);
  if (error) throw new Error(error.message);
  return full;
}

/** A client's changes, newest first. */
export async function listChanges(clientId: string, limit = 50): Promise<ChangeLogEntry[]> {
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    return getDemoStore()
      .changeLog.filter((c) => c.client_id === clientId)
      .slice()
      .reverse()
      .slice(0, limit);
  }
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { data, error } = await createAdminClient()
    .from("change_log")
    .select("*")
    .eq("client_id", clientId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as ChangeLogEntry[];
}

export async function getChange(id: string): Promise<ChangeLogEntry | null> {
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    return getDemoStore().changeLog.find((c) => c.id === id) ?? null;
  }
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { data, error } = await createAdminClient().from("change_log").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as ChangeLogEntry | null) ?? null;
}
