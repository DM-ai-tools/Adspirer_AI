/**
 * Optional structured AuditReport resolution (legacy / tests).
 * Downloads no longer depend on this — they use prepareExportMarkdown.
 */

import type { AuditReport } from "@/lib/report/schema";
import { tryParseAuditReport } from "@/lib/report/schema";
import {
  auditReportFromMarkdown,
  isThinHeuristicReport,
  looksLikeFullAuditMarkdown,
  withWorkingNotes,
} from "@/lib/report/from-markdown";

export function tryParseAuditReportJson(raw: string): AuditReport | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return tryParseAuditReport(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

export function resolveExportAuditReport(input: {
  title: string;
  content: string;
  report?: unknown;
}): AuditReport | null {
  const parsedMd = looksLikeFullAuditMarkdown(input.content)
    ? auditReportFromMarkdown(input.content, input.title)
    : null;
  const safeMd = parsedMd
    ? withWorkingNotes(parsedMd, input.content)
    : null;

  const structured = tryParseAuditReport(input.report);
  const fromJson = tryParseAuditReportJson(input.content);

  if (safeMd && structured && isThinHeuristicReport(structured)) {
    return safeMd;
  }
  if (safeMd && (!structured || isThinHeuristicReport(structured))) {
    return safeMd;
  }
  if (structured && !isThinHeuristicReport(structured)) {
    if (safeMd) {
      const mdActive = safeMd.kpis.find((k) => /^active$/i.test(k.label));
      const stActive = structured.kpis.find((k) => /^active$/i.test(k.label));
      const mdHasActive =
        mdActive && !/no data/i.test(String(mdActive.value));
      const stMissingActive =
        !stActive || /no data/i.test(String(stActive.value));
      if (
        safeMd.campaigns.length > structured.campaigns.length ||
        (mdHasActive && stMissingActive)
      ) {
        return safeMd;
      }
      if (structured.risks.length >= (safeMd.risks.length || 0)) {
        return structured;
      }
      return safeMd;
    }
    return structured;
  }
  return safeMd ?? structured ?? fromJson;
}
