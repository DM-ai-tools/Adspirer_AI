import { listCreativeDraftsAsync, toPublicDraft, type CreativeDraft } from "@/lib/creatives/drafts";
import { readRunMarker } from "@/lib/creatives/formats";
import { pendingDrafts } from "@/lib/creatives/bulk/run";
import { leaseActive, type CreativeRun, type RunItem } from "@/lib/creatives/bulk/runs";

/** Images per client per calendar month the bulk tool aims for. */
export const MONTHLY_TARGET = 150;

export type BulkCard = ReturnType<typeof toPublicDraft> & { item: RunItem };

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
      return { ...pub, image_status: d.image_status === "pending" ? ("pending" as const) : pub.image_status, item };
    })
    .filter((c): c is BulkCard => Boolean(c));
  return {
    run: { ...run, message_map: undefined },
    cards,
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
