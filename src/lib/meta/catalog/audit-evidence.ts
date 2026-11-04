import type { AuditAdSet } from "@/lib/audit/meta-audit-data";
import { renderCatalogEvidence, type CatalogEvidenceInput, type CatalogEvidenceMissing } from "@/lib/audit/render";
import { getCatalogReport, getClientCommerce } from "@/lib/meta/catalog/service";

export const MAX_AUDIT_CATALOGS = 3;
/** The audit waits at most this long for catalogue evidence before going on without it. */
export const CATALOG_EVIDENCE_TIMEOUT_MS = 20_000;
export const CATALOG_EVIDENCE_SLOW_MESSAGE = "Meta was slow to respond";

const missingOf = (state: string): CatalogEvidenceMissing =>
  state === "missing_permission" || state === "catalogs_unreadable" ? state : "no_catalog";

async function readCatalogEvidence(clientId: string, catalogAdSets: AuditAdSet[]): Promise<string> {
  const unread = (message: string, missing: CatalogEvidenceMissing = "no_catalog") =>
    renderCatalogEvidence([{ catalogId: "", missing, message }], catalogAdSets);
  try {
    const commerce = await getClientCommerce(clientId);
    if (commerce.state !== "ok") return unread(commerce.message, missingOf(commerce.state));

    const setIds = new Set(catalogAdSets.map((a) => a.productSetId));
    const allIds = [...new Set(commerce.uses.filter((u) => setIds.has(u.productSetId)).map((u) => u.catalogId))];
    const catalogIds = allIds.slice(0, MAX_AUDIT_CATALOGS);
    if (!catalogIds.length) return unread("no catalogue was found for the audited ad sets' product sets");

    const reports = await Promise.all(
      catalogIds.map(async (catalogId): Promise<CatalogEvidenceInput> => {
        try {
          const report = await getCatalogReport(clientId, catalogId);
          if (report.state !== "ok") return { catalogId, missing: missingOf(report.state), message: report.message };
          return {
            catalogName: report.snapshot.name,
            catalogId,
            snapshot: report.snapshot,
            findings: report.findings,
            learningLinks: report.learningLinks,
          };
        } catch (error) {
          return { catalogId, missing: "no_catalog", message: error instanceof Error ? error.message : String(error) };
        }
      }),
    );
    return renderCatalogEvidence(reports, catalogAdSets, { notChecked: allIds.length - catalogIds.length });
  } catch (error) {
    return unread(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Commerce Manager evidence for a Meta audit: the catalogues behind the audited ad sets
 * (at most MAX_AUDIT_CATALOGS), read in parallel. Returns null when no audited ad set sells
 * from a product set. Never throws, and never waits longer than CATALOG_EVIDENCE_TIMEOUT_MS: a
 * failure or a slow Meta becomes a "Catalogue not read" line so the rest of the audit is untouched.
 */
export async function loadCatalogEvidence(
  clientId: string,
  auditedAdSets: AuditAdSet[],
  timeoutMs: number = CATALOG_EVIDENCE_TIMEOUT_MS,
): Promise<string | null> {
  const catalogAdSets = auditedAdSets.filter((a) => a.productSetId);
  if (!catalogAdSets.length) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const slow = new Promise<string>((resolve) => {
    timer = setTimeout(
      () => resolve(renderCatalogEvidence([{ catalogId: "", missing: "no_catalog", message: CATALOG_EVIDENCE_SLOW_MESSAGE }], catalogAdSets)),
      timeoutMs,
    );
  });
  try {
    // readCatalogEvidence never rejects, so the losing promise cannot surface as unhandled.
    return await Promise.race([readCatalogEvidence(clientId, catalogAdSets), slow]);
  } finally {
    clearTimeout(timer);
  }
}
