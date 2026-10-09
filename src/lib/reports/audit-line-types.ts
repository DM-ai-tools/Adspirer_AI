/**
 * Shared line classifiers for audit export (no sanitize imports — avoid cycles).
 */

const SECTION_TITLE =
  /^(?:\d{1,2}\.\s+)?(?:Executive Summary|Account Snapshot|Tracking (?:&|and) Measurement|Landing Pages|Audit Checklist|Active Campaigns?|Paused Campaign(?:s| Inventory)|What'?s Working|What is Working|Risks(?:\s*&\s*Issues)?|Risk [Rr]egister|Optimizations?(?:\s+Actioned)?|Prioriti[sz]ed Recommendations|Recommendations|Immediate Next Steps|Next Steps)\b/i;

/** Lines that are section titles, not ordered-list steps. */
export function isAuditSectionTitle(line: string): boolean {
  const t = line.trim().replace(/\*\*/g, "");
  if (!t || t.length > 80) return false;
  return SECTION_TITLE.test(t);
}

export function isCampaignHeaderLine(line: string): boolean {
  const t = line
    .trim()
    .replace(/^[\u{1F7E2}\u{2705}*•\-]\s*/u, "")
    .replace(/^[🟢✅*•\-]\s*/, "")
    .replace(/\*\*/g, "");
  if (/^video ad\b|^ad\s*\d+/i.test(t)) return false;
  return /^.+?(?:—|–|\s-\s)\s*\d{15,}\b/.test(t);
}
