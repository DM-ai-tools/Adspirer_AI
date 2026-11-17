import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { mapTaskRow } from "@/lib/db/live-maps";
import type { GoalKind, TargetOption } from "@/lib/strategy/account-strategy";
import { nowIso } from "@/lib/utils";
import type { Task } from "@/types";

/**
 * The strategy targets a turn offered, kept on the task (`tasks.agent_state` is jsonb, so no migration),
 * like the optimise offer. Whether an offer is waiting for a pick, and what "bold" means, is read from
 * here, not from the chat text: the history cuts older replies short (the "pick a target" line at the
 * end of an offer was being lost), and a fresh calculation can differ from what the operator saw, or
 * fail when Meta is slow. A plan closes the offer; a new offer replaces it.
 */

const KEY = "strategy_offer";
/** How many of the conversation's latest tasks to look through. */
const LOOKBACK_TASKS = 12;

export type StrategyOfferRecord =
  | { status: "open"; createdAt: string; kind: GoalKind; options: TargetOption[] }
  | { status: "closed"; createdAt: string };

/** Set on the task (the caller saves the task): an offer shown, or a plan written (closed). */
export function saveStrategyOffer(task: Task, record: { status: "open"; kind: GoalKind; options: TargetOption[] } | { status: "closed" }): void {
  task.agent_state = { ...(task.agent_state ?? {}), [KEY]: { ...record, createdAt: nowIso() } };
}

function readRecord(task: Pick<Task, "agent_state">): StrategyOfferRecord | null {
  const raw = task.agent_state?.[KEY] as Partial<StrategyOfferRecord> | undefined;
  if (!raw || (raw.status !== "open" && raw.status !== "closed")) return null;
  const createdAt = typeof raw.createdAt === "string" ? raw.createdAt : "";
  if (raw.status === "closed") return { status: "closed", createdAt };
  const open = raw as Partial<Extract<StrategyOfferRecord, { status: "open" }>>;
  if (!Array.isArray(open.options) || (open.kind !== "sales" && open.kind !== "leads" && open.kind !== "other")) return null;
  return { status: "open", createdAt, kind: open.kind, options: open.options };
}

/**
 * The latest strategy offer record in the conversation (open or closed), not counting `excludeTaskId`.
 * Null when no turn in reach recorded one (older chats: the text reading stands in).
 */
export async function loadStrategyOffer(
  conversationId: string | null | undefined,
  excludeTaskId?: string,
): Promise<StrategyOfferRecord | null> {
  if (!conversationId) return null;
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    const tasks = getDemoStore()
      .tasks.filter((t) => t.conversation_id === conversationId && t.id !== excludeTaskId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, LOOKBACK_TASKS);
    for (const task of tasks) {
      const record = readRecord(task);
      if (record) return record;
    }
    return null;
  }
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { data, error } = await createAdminClient()
    .from("tasks")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(LOOKBACK_TASKS + 1);
  if (error) throw new Error(error.message);
  for (const row of data ?? []) {
    const task = mapTaskRow(row as Record<string, unknown>);
    if (task.id === excludeTaskId) continue;
    const record = readRecord(task);
    if (record) return record;
  }
  return null;
}

export const TARGETS_TABLE_MARKER = "[[TARGETS_TABLE]]";

/**
 * Puts the computed targets into the proposal: at the writer's marker; else under its "Targets I'd set"
 * line; else at the end. The writer never supplies the figures, so they cannot drift or be invented.
 */
export function insertTargetsTable(reply: string, table: string): string {
  if (!table.trim()) return reply.split(TARGETS_TABLE_MARKER).join("");
  if (reply.includes(TARGETS_TABLE_MARKER)) {
    const [head, ...rest] = reply.split(TARGETS_TABLE_MARKER);
    return `${head}${table}${rest.join("")}`;
  }
  const heading = /^\*\*Targets I'd set\*\*.*$/m.exec(reply);
  if (heading) {
    const at = heading.index + heading[0].length;
    return `${reply.slice(0, at)}\n\n${table}\n${reply.slice(at)}`;
  }
  return `${reply.trimEnd()}\n\n**Targets I'd set**\n\n${table}`;
}

/** The offered options as short lines for the classifier ("Bold — cost per lead 10.23, by 60 days"). */
export function offerOptionLines(record: Extract<StrategyOfferRecord, { status: "open" }>): string[] {
  const unit = record.kind === "sales" ? "purchase" : record.kind === "leads" ? "lead" : "result";
  const amount = (cents: number) => (cents / 100).toFixed(2);
  return record.options.map((o) => {
    const parts = [
      o.conversionsPerDay != null ? `${o.conversionsPerDay} ${unit}s/day` : null,
      o.dailyBudgetCents != null ? `budget ${amount(o.dailyBudgetCents)}/day` : null,
      o.costPerCents != null ? `cost per ${unit} ${amount(o.costPerCents)}` : null,
      o.roas != null ? `ROAS ${o.roas.toFixed(2)}×` : null,
      `by ${o.windowDays} days`,
    ].filter(Boolean);
    return `${o.key[0]!.toUpperCase()}${o.key.slice(1)} — ${parts.join(", ")}`;
  });
}
