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

/** Sections that belong in the chat only: the full audit checklist (every checkpoint, passed ones included). */
const CHAT_ONLY_SECTION = /^#{1,2}\s*(?:\d{1,2}\.\s*)?Audit checklist\b/i;

/**
 * Leave chat-only sections out of a download. A section runs from its heading to the next heading
 * of the same or a higher level (its own ### sub-headings go with it), or to the end.
 */
export function stripChatOnlySections(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let skipping = 0;
  for (const line of lines) {
    const t = line.trim().replace(/\*\*/g, "");
    const heading = /^(#{1,6})\s+/.exec(t);
    if (skipping) {
      if (heading && heading[1]!.length <= skipping) skipping = 0;
      else continue;
    }
    if (CHAT_ONLY_SECTION.test(t)) {
      skipping = heading ? heading[1]!.length : 2;
      // A rule written just before the section belongs to it.
      while (out.length && /^(---+|\*\*\*+|)$/.test(out[out.length - 1]!.trim())) out.pop();
      continue;
    }
    out.push(line);
  }
  return out.join("\n").trimEnd() + "\n";
}

/** The audit's own title line: "# Meta Ads Account Audit — <account>" (any heading level, bold or not). */
const AUDIT_TITLE_LINE = /^[ \t]*#{1,3}[ \t]*\**[ \t]*Meta Ads Account Audit\b/im;

/**
 * An audit starts at its title. Anything the writer said before it ("Let me pull the 12-month data…",
 * "Here is the full audit.") is narration from its tool steps, not part of the report. Text with no
 * audit title is returned as it is.
 */
export function stripAuditPreamble(markdown: string): string {
  const match = AUDIT_TITLE_LINE.exec(markdown);
  if (!match || match.index === 0) return markdown;
  return markdown.slice(match.index);
}

/**
 * Turn operator chat audit text into neat markdown while keeping every detail.
 */
export function prepareExportMarkdown(raw: string, fallbackTitle?: string): string {
  const text = sanitizeReportText(stripChatOnlySections(stripAuditPreamble(raw))).replace(/\r\n/g, "\n").trim();
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
