import { createPendingApproval } from "@/lib/approvals/service";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { isDeliveringStatus, type CatalogFinding } from "@/lib/meta/catalog/findings";
import { getCatalogReport, type CatalogReport } from "@/lib/meta/catalog/service";

const UNMAPPED_ACCOUNTS_NOTE =
  "Ad sets in ad accounts not mapped to this client also use this product set and would change too.";

export const NO_AUTOMATIC_FIX_MESSAGE = "This suggestion has no automatic fix; follow the how-to-fix steps.";

type OkReport = Extract<CatalogReport, { state: "ok" }>;

/** Most ad set names listed in a rationale; the rest are counted. */
export const MAX_RATIONALE_AD_SETS = 25;

/**
 * Every ad set the fix reaches, from the report's uses (this catalogue's ad sets): a filter change
 * reaches every ad set selling that product set, a feed refresh every ad set selling from the
 * catalogue, and a pause just that ad set. Deduped by id; paused ones are marked.
 */
function reachedAdSets(finding: CatalogFinding, uses: OkReport["uses"]): string[] {
  const fix = finding.fix;
  let reached: OkReport["uses"];
  if (fix?.toolName === "update_product_set_filter") reached = uses.filter((u) => u.productSetId === fix.args.product_set_id);
  else if (fix?.toolName === "request_feed_refresh") reached = uses;
  else if (fix?.toolName === "pause_adset") reached = uses.filter((u) => u.adSetId === fix.args.adset_id);
  else reached = uses.filter((u) => finding.adSetIds.includes(u.adSetId));

  const byId = new Map<string, string>();
  for (const u of reached) {
    if (byId.has(u.adSetId)) continue;
    byId.set(u.adSetId, isDeliveringStatus(u.effectiveStatus) ? u.adSetName : `${u.adSetName} (paused)`);
  }
  // A pause target missing from the uses is still named, by id.
  if (fix?.toolName === "pause_adset" && byId.size === 0) byId.set(fix.args.adset_id, fix.args.adset_id);
  return [...byId.values()];
}

/** Why this approval was queued: the finding, every ad set it reaches, and any reach beyond this client. */
export function buildFixRationale(finding: CatalogFinding, uses: OkReport["uses"]): string {
  const lines = [finding.title];
  const names = reachedAdSets(finding, uses);
  if (names.length > 0) {
    const shown = names.slice(0, MAX_RATIONALE_AD_SETS);
    const more = names.length - shown.length;
    lines.push(`Affects ad sets: ${shown.join(", ")}${more > 0 ? `, and ${more} more` : ""}`);
  }
  const toolName = finding.fix?.toolName;
  if (toolName === "update_product_set_filter" || toolName === "request_feed_refresh") {
    lines.push(UNMAPPED_ACCOUNTS_NOTE);
  }
  return lines.join("\n");
}

export type QueueFixResult =
  | { ok: true; approvalId: string }
  | { ok: false; report: Exclude<CatalogReport, { state: "ok" }> };

/**
 * Queues the fix attached to one finding for approval. The finding (and so the fix and its
 * arguments) always comes from a fresh server-side report, never from the request.
 */
export async function queueCatalogFix(input: {
  clientId: string;
  catalogId: string;
  findingId: string;
  userId: string;
}): Promise<QueueFixResult> {
  const report = await getCatalogReport(input.clientId, input.catalogId);
  if (report.state !== "ok") return { ok: false, report };

  const finding = report.findings.find((f) => f.id === input.findingId);
  if (!finding) throw new NotFoundError("That suggestion is no longer in this catalogue's report.");
  if (!finding.fix) throw new ValidationError(NO_AUTOMATIC_FIX_MESSAGE);

  const approval = await createPendingApproval({
    clientId: input.clientId,
    toolName: finding.fix.toolName,
    proposedArgs: { ...finding.fix.args },
    rationale: buildFixRationale(finding, report.uses),
    requestedBy: input.userId,
    // Double-clicking "Queue fix" is a new request each time; it must not queue the change twice.
    reuseAcrossTasks: true,
  });
  return { ok: true, approvalId: approval.id };
}
