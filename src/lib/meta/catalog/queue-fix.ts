import { createPendingApproval } from "@/lib/approvals/service";
import { NotFoundError, ValidationError } from "@/lib/errors";
import type { CatalogFinding } from "@/lib/meta/catalog/findings";
import { getCatalogReport, type CatalogReport } from "@/lib/meta/catalog/service";

const UNMAPPED_ACCOUNTS_NOTE =
  "Ad sets in ad accounts not mapped to this client also use this product set and would change too.";

export const NO_AUTOMATIC_FIX_MESSAGE = "This suggestion has no automatic fix; follow the how-to-fix steps.";

type OkReport = Extract<CatalogReport, { state: "ok" }>;

/** Why this approval was queued: the finding, the ad sets it touches, and any reach beyond this client. */
export function buildFixRationale(finding: CatalogFinding, uses: OkReport["uses"]): string {
  const nameOf = new Map(uses.map((u) => [u.adSetId, u.adSetName]));
  const lines = [finding.title];
  if (finding.adSetIds.length > 0) {
    lines.push(`Affects ad sets: ${finding.adSetIds.map((id) => nameOf.get(id) ?? id).join(", ")}`);
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
