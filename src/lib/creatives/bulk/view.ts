import { listCreativeDraftsAsync, toPublicDraft, type CreativeDraft } from "@/lib/creatives/drafts";
import { readRunMarker } from "@/lib/creatives/formats";
import { readDirectedMarker } from "@/lib/creatives/directed/markers";
import { pendingDrafts } from "@/lib/creatives/bulk/run";
import { leaseActive, type CreativeRun, type RunItem } from "@/lib/creatives/bulk/runs";

/** Images per client per calendar month the bulk tool aims for. */
export const MONTHLY_TARGET = 300;

/** The card's item without storage keys, plus what edits it has had. */
export type BulkCard = ReturnType<typeof toPublicDraft> & {
  item: Omit<RunItem, "versions">;
  edits: Array<{ id: string; at: string; instruction: string; mode: "edit" | "full"; understood?: string }>;
  editError: string | null;
  /** What this ad's copy still does not follow of the operator's instructions, or null. */
  copyNote: string | null;
  /** True once the operator edited this ad's copy by hand. */
  copyEdited: boolean;
};

/** A copy-writing job still "writing" this long after it started is treated as lost (a restart can kill it). */
export const COPY_STALL_MS = 10 * 60 * 1000;

export type CopySummary = { status: "writing" | "ready" | "failed"; message: string | null; repaired: number; flagged: number };

/** The run's ad copy state for its header, or null when no ad copy instructions were given. A stalled job reads as failed. */
export function copySummary(run: CreativeRun, now = Date.now()): CopySummary | null {
  const { copyStatus, copyStartedAt, copyMessage, copyRepaired, copyFlagged } = run.inputs;
  if (!copyStatus) return null;
  const stalled = copyStatus === "writing" && copyStartedAt !== undefined && now - Date.parse(copyStartedAt) > COPY_STALL_MS;
  if (stalled) return { status: "failed", message: "The ad copy took too long to write, so each ad keeps the words printed on its image.", repaired: copyRepaired ?? 0, flagged: copyFlagged ?? 0 };
  return { status: copyStatus, message: copyMessage ?? null, repaired: copyRepaired ?? 0, flagged: copyFlagged ?? 0 };
}

export type BulkProgress = { total: number; succeeded: number; failed: number; rendering: number; waiting: number };

export function progressOf(drafts: CreativeDraft[]): BulkProgress {
  const count = (s: string) => drafts.filter((d) => d.image_status === s).length;
  return {
    total: drafts.length,
    succeeded: count("succeeded"),
    failed: count("failed"),
    rendering: count("generating"),
    waiting: count("pending"),
  };
}

/** The run's cards in slot order. A draft waiting for its turn is shown as waiting, not as a stalled failure. */
export async function loadRunView(run: CreativeRun) {
  const all = await listCreativeDraftsAsync(run.client_id);
  const byId = new Map(all.map((d) => [d.id, d]));
  const drafts = run.items.map((i) => byId.get(i.draft_id)).filter((d): d is CreativeDraft => Boolean(d));
  const cards: BulkCard[] = run.items
    .map((item) => {
      const d = byId.get(item.draft_id);
      if (!d) return null;
      const pub = toPublicDraft(d);
      const { versions, ...rest } = item;
      // An image made from a direction keeps its kept versions and edit instructions in its own marker, not on the run item.
      const directed = readDirectedMarker(d.creative_direction);
      const kept = directed?.versions ?? [];
      const instructions = directed?.edits ?? [];
      const directedEdits = kept.map((key, i) => ({ id: key, at: d.updated_at, instruction: instructions[instructions.length - kept.length + i] ?? "Edit", mode: "edit" as const }));
      return {
        ...pub,
        image_status: d.image_status === "pending" ? ("pending" as const) : pub.image_status,
        item: rest,
        edits: directed
          ? directedEdits
          : (versions ?? []).map((v) => ({ id: v.id, at: v.at, instruction: v.instruction, mode: v.mode, ...(v.understood ? { understood: v.understood } : {}) })),
        editError: item.edit_error ?? null,
        copyNote: item.copy_note ?? null,
        copyEdited: Boolean(item.copy_edited),
      };
    })
    .filter((c): c is BulkCard => Boolean(c));
  return {
    run: { ...run, message_map: undefined },
    cards,
    copy: copySummary(run),
    progress: progressOf(drafts),
    needsContinue: run.status === "rendering" && !leaseActive(run) && pendingDrafts(drafts).length > 0,
  };
}

/** Succeeded, kept images made by bulk runs this calendar month. */
export async function monthlyCount(clientId: string, runs: CreativeRun[], now = new Date()): Promise<number> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const runIds = new Set(runs.filter((r) => r.created_at >= monthStart).map((r) => r.id));
  if (!runIds.size) return 0;
  const all = await listCreativeDraftsAsync(clientId);
  return all.filter((d) => {
    const id = readRunMarker(d.creative_direction);
    return id && runIds.has(id) && d.image_status === "succeeded" && d.status !== "rejected";
  }).length;
}
