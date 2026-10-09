/**
 * Report quality gate — detect glued words / placeholder leaks and polish
 * until the export is stakeholder-ready.
 */

import {
  blocksToPlainPreview,
  parseMarkdownToBlocks,
  repairGluedProse,
  sanitizeReportText,
} from "@/lib/reports/parse-markdown";
import { prepareExportMarkdown } from "@/lib/reports/prepare-export";

export type ReportQualityIssue = {
  code: "glued_words" | "undefined_token" | "long_token" | "empty";
  detail: string;
};

export type ReportQualityResult = {
  ok: boolean;
  score: number;
  issues: ReportQualityIssue[];
  plainPreview: string;
};

/** Tokens that often glue onto neighbours in LLM audit prose. */
const DOMAIN_WORDS = [
  "campaign",
  "campaigns",
  "backup",
  "engaged",
  "page",
  "pages",
  "aligned",
  "benchmark",
  "naming",
  "objective",
  "objectives",
  "delivering",
  "delivery",
  "fatigues",
  "fatigue",
  "disapprovals",
  "approvals",
  "retargeting",
  "targeting",
  "interest",
  "based",
  "active",
  "paused",
  "live",
  "list",
  "have",
  "has",
  "with",
  "from",
  "into",
  "that",
  "this",
  "are",
  "was",
  "were",
  "been",
  "being",
  "meta",
  "pixel",
  "leads",
  "lead",
  "gen",
  "traffic",
  "outcome",
  "budget",
  "creative",
  "creatives",
  "account",
  "adset",
  "adsets",
  "and",
  "or",
  "in",
  "is",
  "so",
  "to",
  "for",
  "the",
  "of",
  "on",
  "at",
  "by",
  "no",
  "not",
  "yet",
  "set",
  "level",
  "users",
  "who",
  "visited",
  "landing",
  "follow",
  "up",
  "path",
  "confirm",
  "confirmation",
  "firing",
  "correctly",
  "attributed",
  "split",
  "test",
  "running",
  "visible",
  "specified",
  "overview",
  "structure",
  "health",
  "policy",
  "flags",
  "detected",
  "room",
  "scale",
  "before",
  "burnout",
  "iteration",
  "dated",
  "disciplined",
  "named",
  "undefined",
] as const;

const WORD_SET = new Set(DOMAIN_WORDS.map((w) => w.toLowerCase()));

function canFullySplit(lower: string): boolean {
  if (WORD_SET.has(lower)) return true;
  if (lower.length < 4) return false;
  for (let i = Math.min(lower.length - 2, 16); i >= 2; i -= 1) {
    const left = lower.slice(0, i);
    const right = lower.slice(i);
    if (WORD_SET.has(left) && canFullySplit(right)) return true;
  }
  return false;
}

/**
 * Split a single alphanumeric token if it is clearly two domain words glued.
 * Safe for campaign IDs / URLs (those are skipped by callers).
 */
export function splitGluedToken(token: string): string {
  if (token.length < 6) return token;
  if (!/^[A-Za-z]+$/.test(token)) return token;
  // ALLCAPS acronyms / objectives
  if (/^[A-Z0-9_]{3,}$/.test(token)) return token;

  const lower = token.toLowerCase();

  // Prefer longest left match that is a known word, with a fully known right
  // side. The left part must be 3+ letters: two-letter splits turned real words
  // into nonsense ("inactive" → "in active", "island" → "is land").
  let best: string | null = null;
  for (let i = Math.min(lower.length - 2, 18); i >= 3; i -= 1) {
    const left = lower.slice(0, i);
    const right = lower.slice(i);
    if (!WORD_SET.has(left)) continue;
    if (!canFullySplit(right)) continue;
    const rightOut = WORD_SET.has(right)
      ? token.slice(i)
      : splitGluedToken(token.slice(i));
    if (rightOut.replace(/\s+/g, "").length < 2) continue;
    best = `${token.slice(0, i)} ${rightOut}`;
    break;
  }
  // No camelCase fallback — it split brand names (TikTok → "Tik Tok").
  return best ?? token;
}

/** Apply token splitting across prose while preserving markdown markers & URLs. */
export function deglueReportProse(text: string): string {
  return text
    .split(/(\s+|https?:\/\/\S+|\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g)
    .map((part) => {
      if (!part) return part;
      if (/^\s+$/.test(part)) return part.length > 1 && part.includes("\n") ? part : part.replace(/[^\S\n]+/g, " ");
      if (/^https?:\/\//i.test(part)) return part;
      if (part.startsWith("**") || part.startsWith("*") || part.startsWith("`")) {
        // Split inside emphasis, keep markers
        if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
          const inner = splitGluedToken(part.slice(2, -2));
          return `**${inner}**`;
        }
        return part;
      }
      // Pipe tables / IDs — leave alone if mostly digits or underscores
      if (/^\d{8,}$/.test(part) || /_/.test(part)) return part;
      return splitGluedToken(part);
    })
    .join("");
}

export function verifyReportQuality(markdown: string): ReportQualityResult {
  const plain = blocksToPlainPreview(parseMarkdownToBlocks(markdown));
  const issues: ReportQualityIssue[] = [];

  if (!plain.trim()) {
    issues.push({ code: "empty", detail: "Report body is empty" });
  }

  if (/\bundefined\b/i.test(plain) || /\bnull\b/i.test(plain)) {
    issues.push({
      code: "undefined_token",
      detail: "Placeholder undefined/null still present",
    });
  }

  // Long glued tokens (no space, mixed letters, length >= 12)
  const glued: string[] = [];
  for (const token of plain.split(/\s+/)) {
    const clean = token.replace(/[^A-Za-z]/g, "");
    if (clean.length < 10) continue;
    if (/^[A-Z0-9_]+$/.test(token)) continue; // OUTCOME_LEADS etc.
    if (!/^[A-Za-z]+$/.test(clean)) continue;
    // If it contains two domain words jammed together, flag it
    const split = splitGluedToken(clean);
    if (split !== clean && split.includes(" ")) {
      glued.push(clean);
    } else if (
      clean.length >= 14 &&
      !WORD_SET.has(clean.toLowerCase()) &&
      /[a-z]{4,}[a-z]{4,}/i.test(clean)
    ) {
      // Heuristic: very long unknown lowercase blob
      glued.push(clean);
    }
  }
  if (glued.length) {
    issues.push({
      code: "glued_words",
      detail: `Merged words: ${glued.slice(0, 8).join(", ")}`,
    });
  }

  const longTokens = plain
    .split(/\s+/)
    .filter((t) => t.length > 48 && !/^https?:\/\//i.test(t));
  if (longTokens.length) {
    issues.push({
      code: "long_token",
      detail: `Oversized tokens: ${longTokens.slice(0, 3).join(", ")}`,
    });
  }

  const penalty = issues.reduce((n, issue) => {
    if (issue.code === "glued_words") return n + 40;
    if (issue.code === "undefined_token") return n + 30;
    if (issue.code === "long_token") return n + 15;
    if (issue.code === "empty") return n + 100;
    return n;
  }, 0);
  const score = Math.max(0, 100 - penalty);

  return {
    ok: issues.length === 0 && score >= 80,
    score,
    issues,
    plainPreview: plain.slice(0, 500),
  };
}

export type PolishReportResult = {
  markdown: string;
  quality: ReportQualityResult;
  passes: number;
};

/**
 * Prepare + repeatedly de-glue until quality passes (or max passes).
 */
export function polishReportForExport(
  raw: string,
  fallbackTitle?: string,
  maxPasses = 4,
): PolishReportResult {
  let markdown = prepareExportMarkdown(raw, fallbackTitle);
  let quality = verifyReportQuality(markdown);
  let passes = 0;

  while (!quality.ok && passes < maxPasses) {
    passes += 1;
    markdown = sanitizeReportText(deglueReportProse(repairGluedProse(markdown)));
    // Re-apply structure prep so headings/tables stay intact
    markdown = prepareExportMarkdown(markdown, fallbackTitle);
    quality = verifyReportQuality(markdown);
  }

  // Final pass always runs deglue once more on the prepared body
  if (!quality.ok) {
    markdown = prepareExportMarkdown(
      deglueReportProse(sanitizeReportText(markdown)),
      fallbackTitle,
    );
    quality = verifyReportQuality(markdown);
    passes += 1;
  }

  return { markdown, quality, passes };
}
