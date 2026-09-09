/**
 * Lightweight markdown → structured blocks for report export.
 * Handles headings, paragraphs, lists, tables, horizontal rules, and inline bold/italic/code.
 */

import {
  isAuditSectionTitle,
  isCampaignHeaderLine,
} from "@/lib/reports/audit-line-types";

export type InlineSpan =
  | { type: "text"; text: string }
  | { type: "bold"; text: string }
  | { type: "italic"; text: string }
  | { type: "code"; text: string };

export type ReportBlock =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "paragraph"; spans: InlineSpan[] }
  | { type: "list"; ordered: boolean; items: InlineSpan[][] }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "hr" };

/** Unicode space / separator chars that must become normal spaces (not deleted). */
const UNICODE_SPACES =
  /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\u180E\uFEFF]/g;
const ZERO_WIDTH = /[\u200B-\u200D\u2060]/g;

/**
 * Insert spaces around **bold** / *italic* when glued to neighbouring words.
 * `above**Meta**benchmark` → `above **Meta** benchmark`
 */
export function ensureMarkdownEmphasisSpacing(text: string): string {
  const withBold = text.replace(
    /([A-Za-z0-9)])?\*\*([^*]+)\*\*([A-Za-z0-9(])?/g,
    (_m, before: string | undefined, inner: string, after: string | undefined) => {
      const left = before ? `${before} ` : "";
      const right = after ? ` ${after}` : "";
      return `${left}**${String(inner).trim()}**${right}`;
    },
  );
  // Single-star italic only (not part of **)
  return withBold.replace(
    /([A-Za-z0-9)])?(?<!\*)\*([^*]+)\*(?!\*)([A-Za-z0-9(])?/g,
    (_m, before: string | undefined, inner: string, after: string | undefined) => {
      const left = before ? `${before} ` : "";
      const right = after ? ` ${after}` : "";
      return `${left}*${String(inner).trim()}*${right}`;
    },
  );
}

/**
 * Drop leaked JS placeholders and split common camelCase / glued particles in prose.
 */
export function repairGluedProse(text: string): string {
  return (
    text
      .replace(/\bundefined\b/gi, "")
      .replace(/\bnull\b/gi, "")
      .replace(/([A-Za-z])(?:undefined|null)\b/gi, "$1")
      .replace(/\b(?:undefined|null)([A-Za-z])/gi, "$1")
      .replace(/([a-z])([A-Z][a-z]+)/g, "$1 $2")
      // High-frequency audit merges from Meta reports
      .replace(/\b(campaign)(list|or|in|active|fatigues|named|is)\b/gi, "$1 $2")
      .replace(/\b(and)(delivering|iteration|delivery)\b/gi, "$1 $2")
      .replace(/\b(backup|engaged)(or)\b/gi, "$1 $2")
      .replace(/\b(page)(have|so)\b/gi, "$1 $2")
      .replace(/\b(aligned)(with)\b/gi, "$1 $2")
      .replace(/\b(gen)(objective)\b/gi, "$1 $2")
      .replace(/\b(lead)(gen)\b/gi, "$1 $2")
      .replace(/\b(ad)(set)\b/gi, "$1 $2")
      .replace(/\b(no)(dis[a-z]+|approvals?|policy)\b/gi, "$1 $2")
      .replace(/([a-z])(Meta)\b/g, "$1 $2")
      .replace(/([a-z]{4,}?)(for|to)(?=[\s\-,.;:!]|$)/gi, "$1 $2")
      .replace(/([a-z]{4,})(namingis)\b/gi, "$1 naming is")
      .replace(/([a-z]{4,})(naming)\b/gi, "$1 $2")
      .replace(/[^\S\n]{2,}/g, " ")
      .replace(/ *\n */g, "\n")
  );
}

/**
 * When adjacent inline spans both end/start on a word character, insert a space
 * so HTML/PDF don't render `above<strong>Meta</strong>` as "aboveMeta".
 */
export function spaceAdjacentSpans(spans: InlineSpan[]): InlineSpan[] {
  if (spans.length < 2) return spans;
  const out: InlineSpan[] = [];
  for (let i = 0; i < spans.length; i += 1) {
    const span = {
      ...spans[i],
      text: spans[i].text.replace(/\u00A0/g, " "),
    };
    if (out.length) {
      const prev = out[out.length - 1];
      const prevEnd = prev.text.slice(-1);
      const nextStart = span.text.slice(0, 1);
      const needsSpace =
        Boolean(prevEnd && nextStart) &&
        /[A-Za-z0-9)]$/.test(prevEnd) &&
        /^[A-Za-z0-9(]/.test(nextStart) &&
        !/\s$/.test(prev.text) &&
        !/^\s/.test(span.text);
      if (needsSpace) {
        out.push({ type: "text", text: " " });
      }
    }
    if (span.text.length) out.push(span);
  }
  return out.length ? out : [{ type: "text", text: "" }];
}

/** Normalize curly quotes / mojibake / emoji that break Latin-1 PDF fonts. */
export function sanitizeReportText(input: string): string {
  let out = String(input ?? "")
    // Convert exotic spaces FIRST — deleting them glued words together
    .replace(ZERO_WIDTH, "")
    .replace(UNICODE_SPACES, " ")
    .replace(/\r\n/g, "\n")
    .replace(/[\u2018\u2019\u201A]/g, "'")
    .replace(/[\u201C\u201D\u201E]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...")
    // Common UTF-8→Latin1 mojibake for emoji / checkmarks
    .replace(/â€[™œ]/g, "'")
    .replace(/â€"/g, "-")
    .replace(/âœ…|âœ”|âœ“|âœ¨/g, "")
    .replace(/â\x9c\x85/g, "")
    .replace(/â[^\x00-\x7F]*/g, "")
    .replace(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\u00FF]/g, (ch) => {
      // Keep latin supplement; drop other symbols that Helvetica can't draw
      const code = ch.codePointAt(0) ?? 0;
      if (code >= 0xa0 && code <= 0xff) return ch;
      // Any leftover separator-class char → space, never delete
      if (/\p{Z}/u.test(ch)) return " ";
      return "";
    });

  out = ensureMarkdownEmphasisSpacing(out);
  out = repairGluedProse(out);

  return out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[^\S\n]{2,}/g, " ")
    .trim();
}

export function parseInline(text: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) != null) {
    if (match.index > last) {
      spans.push({ type: "text", text: text.slice(last, match.index) });
    }
    const token = match[0];
    if (token.startsWith("**")) {
      spans.push({ type: "bold", text: token.slice(2, -2) });
    } else if (token.startsWith("*")) {
      spans.push({ type: "italic", text: token.slice(1, -1) });
    } else {
      spans.push({ type: "code", text: token.slice(1, -1) });
    }
    last = match.index + token.length;
  }
  if (last < text.length) spans.push({ type: "text", text: text.slice(last) });
  if (!spans.length) spans.push({ type: "text", text });
  return spaceAdjacentSpans(spans);
}

function spansToPlain(spans: InlineSpan[]): string {
  return spans.map((s) => s.text).join("");
}

function isTableSeparator(line: string): boolean {
  return /^\|?[\s:-]+\|[\s|:-]*\|?$/.test(line.trim());
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((c) =>
    sanitizeReportText(c.trim().replace(/\*\*/g, "")),
  );
}

export function parseMarkdownToBlocks(markdown: string): ReportBlock[] {
  const text = sanitizeReportText(markdown);
  const lines = text.split("\n");
  const blocks: ReportBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    if (/^---+$/.test(trimmed) || /^\*\*\*+$/.test(trimmed)) {
      blocks.push({ type: "hr" });
      i += 1;
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(trimmed);
    if (heading) {
      const level = Math.min(heading[1].length, 3) as 1 | 2 | 3;
      blocks.push({
        type: "heading",
        level,
        text: sanitizeReportText(heading[2].replace(/\*\*/g, "")),
      });
      i += 1;
      continue;
    }

    // Audit section titles (e.g. "1. Account Snapshot") — not ordered lists
    if (isAuditSectionTitle(trimmed)) {
      blocks.push({
        type: "heading",
        level: 2,
        text: sanitizeReportText(trimmed.replace(/\*\*/g, "")),
      });
      i += 1;
      continue;
    }

    if (isCampaignHeaderLine(trimmed)) {
      blocks.push({
        type: "heading",
        level: 3,
        text: sanitizeReportText(
          trimmed.replace(/^[🟢✅*•\-]\s*/, "").replace(/\*\*/g, ""),
        ),
      });
      i += 1;
      continue;
    }

    if (/^Meta Ads Account Audit\b/i.test(trimmed.replace(/\*\*/g, ""))) {
      blocks.push({
        type: "heading",
        level: 1,
        text: sanitizeReportText(trimmed.replace(/\*\*/g, "")),
      });
      i += 1;
      continue;
    }

    // Table: header + separator + rows
    if (
      trimmed.includes("|") &&
      i + 1 < lines.length &&
      isTableSeparator(lines[i + 1])
    ) {
      const headers = splitTableRow(trimmed);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().includes("|")) {
        if (isTableSeparator(lines[i])) {
          i += 1;
          continue;
        }
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      blocks.push({ type: "table", headers, rows });
      continue;
    }

    // Unordered list
    if (/^[-*+]\s+/.test(trimmed)) {
      const items: InlineSpan[][] = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
        items.push(parseInline(lines[i].trim().replace(/^[-*+]\s+/, "")));
        i += 1;
      }
      blocks.push({ type: "list", ordered: false, items });
      continue;
    }

    // Ordered list (real steps — not audit section titles)
    if (/^\d+[.)]\s+/.test(trimmed) && !isAuditSectionTitle(trimmed)) {
      const items: InlineSpan[][] = [];
      while (
        i < lines.length &&
        /^\d+[.)]\s+/.test(lines[i].trim()) &&
        !isAuditSectionTitle(lines[i].trim())
      ) {
        items.push(parseInline(lines[i].trim().replace(/^\d+[.)]\s+/, "")));
        i += 1;
      }
      if (items.length) {
        blocks.push({ type: "list", ordered: true, items });
      }
      continue;
    }

    // Paragraph (consume until blank)
    const para: string[] = [trimmed];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^#{1,3}\s+/.test(lines[i].trim()) &&
      !/^[-*+]\s+/.test(lines[i].trim()) &&
      !(
        /^\d+[.)]\s+/.test(lines[i].trim()) &&
        !isAuditSectionTitle(lines[i].trim())
      ) &&
      !isAuditSectionTitle(lines[i].trim()) &&
      !isCampaignHeaderLine(lines[i].trim()) &&
      !/^Meta Ads Account Audit\b/i.test(
        lines[i].trim().replace(/\*\*/g, ""),
      ) &&
      !/^---+$/.test(lines[i].trim()) &&
      !(
        lines[i].includes("|") &&
        i + 1 < lines.length &&
        isTableSeparator(lines[i + 1])
      )
    ) {
      para.push(lines[i].trim());
      i += 1;
    }
    blocks.push({ type: "paragraph", spans: parseInline(para.join(" ")) });
  }

  return blocks;
}

export function blocksToPlainPreview(blocks: ReportBlock[]): string {
  return blocks
    .map((b) => {
      if (b.type === "heading") return b.text;
      if (b.type === "paragraph") return spansToPlain(b.spans);
      if (b.type === "list")
        return b.items.map((it) => `- ${spansToPlain(it)}`).join("\n");
      if (b.type === "table")
        return [b.headers.join(" | "), ...b.rows.map((r) => r.join(" | "))].join(
          "\n",
        );
      return "";
    })
    .filter(Boolean)
    .join("\n");
}
