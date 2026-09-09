/**
 * Normalize chat audit prose into clean markdown for faithful downloads.
 * Goal: zero content loss — do not reshape into a separate report schema.
 */

import { sanitizeReportText } from "@/lib/reports/parse-markdown";
import {
  isAuditSectionTitle,
  isCampaignHeaderLine,
} from "@/lib/reports/audit-line-types";

const AUDIT_TITLE = /^Meta Ads Account Audit\b/i;

/**
 * Turn operator chat audit text into neat markdown while keeping every detail.
 */
export function prepareExportMarkdown(raw: string, fallbackTitle?: string): string {
  const text = sanitizeReportText(raw).replace(/\r\n/g, "\n").trim();
  if (!text) return fallbackTitle ? `# ${fallbackTitle}\n` : "";

  const lines = text.split("\n");
  const out: string[] = [];
  let sawH1 = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    if (!trimmed) {
      if (out.length && out[out.length - 1] !== "") out.push("");
      continue;
    }

    const existingHeading = /^(#{1,3})\s+(.+)$/.exec(trimmed);
    if (existingHeading) {
      const level = existingHeading[1];
      const title = existingHeading[2].replace(/[🟢🔴🟡✅⏳⚠️✦]/g, "").trim();
      out.push(`${level} ${title}`);
      if (level === "#") sawH1 = true;
      continue;
    }

    if (/^---+$/.test(trimmed) || /^\*\*\*+$/.test(trimmed)) {
      out.push("---");
      continue;
    }

    if (!sawH1 && AUDIT_TITLE.test(trimmed.replace(/\*\*/g, ""))) {
      out.push(
        `# ${trimmed.replace(/\*\*/g, "").replace(/[🟢✦]/g, "").trim()}`,
      );
      sawH1 = true;
      continue;
    }

    if (isAuditSectionTitle(trimmed)) {
      out.push(`## ${trimmed.replace(/\*\*/g, "").trim()}`);
      continue;
    }

    if (isCampaignHeaderLine(trimmed)) {
      const clean = trimmed
        .replace(/^[🟢✅*•\-]\s*/, "")
        .replace(/\*\*/g, "")
        .trim();
      out.push(`### ${clean}`);
      continue;
    }

    out.push(trimmed.replace(/[🟢🔴🟡✅⏳⚠️✦]/g, "").trimEnd());
  }

  let body = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();

  if (!sawH1 && fallbackTitle) {
    body = `# ${sanitizeReportText(fallbackTitle)}\n\n${body}`;
  }

  return `${body}\n`;
}

/** Best-effort filename / cover title from audit body. */
export function inferExportTitle(content: string, fallback: string): string {
  const prepared = content.replace(/\r\n/g, "\n");
  const fromPrepared = /^#\s+(.+)$/m.exec(prepareExportMarkdown(prepared))?.[1];
  if (fromPrepared) return sanitizeReportText(fromPrepared).slice(0, 120);

  const fromLine =
    /Meta Ads Account Audit\s*[—–-]\s*[^\n*]+/i.exec(prepared)?.[0] ||
    /Meta Ads Account Audit[^\n]*/i.exec(prepared)?.[0];
  if (fromLine) return sanitizeReportText(fromLine).slice(0, 120);

  const account =
    /Account\s*:\s*([^(:\n]+?)\s*\(\s*act_/i.exec(prepared)?.[1]?.trim();
  if (account && !/^here'?s?\b/i.test(account)) {
    return `Meta Ads Account Audit — ${sanitizeReportText(account)}`;
  }
  return sanitizeReportText(fallback).slice(0, 120) || "Adspirer report";
}

export { isAuditSectionTitle, isCampaignHeaderLine };
