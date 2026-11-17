import { parseDateRangeFromText } from "@/lib/agent/audit-brief";
import type { AgentHistoryMessage } from "@/lib/agent/history";

export type PriorFinding = { id: string; title: string; evidence: string | null; source: "audit" | "comparison" | "strategy" };
export type PriorReports = { findings: PriorFinding[]; used: string[]; ignored: string[] };

type Kind = "audit" | "comparison";
type Parsed = { findings: PriorFinding[]; oldNumbering: boolean };

const AUDIT_TITLE = /^#\s*Meta Ads Account Audit\b/m;
const COMPARISON_TITLE = /^#\s*Meta Ads Comparison Report\b/m;

/** "2026-10-01 → 2026-10-15" is how reports write ranges; the shared parser wants "to". */
function readRange(text: string): { dateStart: string; dateStop: string } | null {
  try {
    const r = parseDateRangeFromText(text.replace(/\s*(?:→|->|➝)\s*/g, " to "));
    return r ? { dateStart: r.dateStart, dateStop: r.dateStop } : null;
  } catch {
    return null;
  }
}

/** Audit period: the "**Period:**" line, read the way `strategyPeriod` reads it. */
function auditPeriod(text: string): { dateStart: string; dateStop: string } | null {
  const line = text.match(/\*\*Period:?\*\*:?\s*([^\n·]+)/)?.[1];
  return line ? readRange(line) : null;
}

/** Section 0 of a comparison report (up to the next "## " heading). */
function section0(text: string): string {
  return text.match(/^##\s*0\.[^\n]*\n([\s\S]*?)(?=^##\s|\s*$(?![\s\S]))/m)?.[1] ?? "";
}

/**
 * Comparison period: the first date range after the word "current" in section 0, with or without
 * colon or bold ("- **Current:** 2026-10-01 → 2026-10-15", "**Windows**: current 1 Oct to 15 Oct (15
 * days); previous …"), read up to ";" or "previous". Failing that, the first ISO date range in
 * section 0 (natural dates are only trusted after "current").
 */
function comparisonPeriod(text: string): { dateStart: string; dateStop: string } | null {
  const body = section0(text);
  for (const line of body.split("\n")) {
    const after = line.match(/\bcurrent\b\s*(?:window)?\s*\**\s*:?\s*\**\s*([^\n]*)/i)?.[1];
    if (!after) continue;
    const range = readRange(after.split(/;|\bprevious\b|\bvs\.?\b|\bcompar/i)[0]);
    if (range) return range;
  }
  for (const line of body.split("\n")) {
    if (!/\b20\d{2}-\d{2}-\d{2}\b/.test(line)) continue;
    const range = readRange(line.split(/;|\bprevious\b/i)[0]);
    if (range) return range;
  }
  return null;
}

/**
 * Campaign-scoped = a Scope line says so. The writers are told to open with "**Scope:** whole
 * account" or "**Scope:** campaigns: <names>" (audit: on the Period line; comparison: in section 0);
 * the application's own "Entire ad account" / "Selected campaigns" wording is read too. A value
 * starting "whole" / "entire" is whole-account; one starting "campaign(s)" or naming selected /
 * specific campaigns is campaign-scoped. With no Scope line at all the report is whole-account,
 * unless its header says "campaign audit" (or has a "Campaigns:" line).
 */
const SCOPED_WORDING = /\b(?:selected|specific|chosen|named)\s+campaigns?\b|\bcampaign\s+audit\b|\bonly\s+(?:the\s+)?(?:selected\s+)?campaigns?\b|\bnot\s+only\b/i;

function scopeValueIsCampaigns(scope: string): boolean {
  if (/^\W*(?:entire|whole)\b/i.test(scope)) return false;
  if (/^\W*campaigns?\b/i.test(scope)) return true;
  return SCOPED_WORDING.test(scope) || (!/\b(?:entire|whole|all)\b/i.test(scope) && /\bcampaigns?\b/i.test(scope));
}

function auditIsCampaignScoped(text: string): boolean {
  const header = text.slice(0, 2_000);
  const scope = header.match(/\*\*Scope:?\*\*:?\s*([^\n]+)/)?.[1];
  if (scope) return scopeValueIsCampaigns(scope);
  return /^\s*[-*]?\s*\**Campaigns?:\**\s*\S/m.test(header) || /\bcampaign\s+audit\b/i.test(header);
}

function comparisonIsCampaignScoped(text: string): boolean {
  const body = section0(text);
  const scope = body.match(/\*\*Scope:?\*\*\s*:?\s*([^\n]+)/i)?.[1] ?? body.match(/^\s*[-*]?\s*Scope\s*:\s*([^\n]+)/im)?.[1];
  return scope ? scopeValueIsCampaigns(scope) : false;
}

function parseAudit(text: string): Parsed {
  const findings: PriorFinding[] = [];
  const oldNumbering = !/^###\s*AUD-\d{3}\b/m.test(text) && /^###\s*R\d+\b/m.test(text);
  const parts = text.split(/^(?=###\s)/m);
  for (const part of parts) {
    const head = part.match(/^###\s*(AUD-\d{3})\b([^\n]*)/);
    if (!head) continue;
    const title = head[2].match(/[—–]\s*(.+?)\s*$/)?.[1]?.trim();
    if (!title) continue;
    const evidence = part.match(/\*\*Evidence:?\*\*:?\s*([^\n]+)/)?.[1]?.trim() || null;
    findings.push({ id: head[1], title, evidence, source: "audit" });
  }
  return { findings, oldNumbering };
}

function parseComparison(text: string): Parsed {
  const findings: PriorFinding[] = [];
  const section12 = text.match(/^##\s*12\.[^\n]*\n([\s\S]*?)(?=^##\s*13\.|(?![\s\S]))/m)?.[1] ?? text;
  for (const line of section12.split("\n")) {
    if (!/^\s*\|\s*(CMP-\d{3})\s*\|/.test(line)) continue;
    const cells = line.trim().replace(/^\|/, "").replace(/\|\s*$/, "").split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
    const [id, title, evidence] = cells;
    if (!title) continue;
    findings.push({ id, title, evidence: evidence || null, source: "comparison" });
  }
  return { findings, oldNumbering: false };
}

/**
 * Findings from the latest audit and latest comparison report in the chat, so a strategy can cite
 * AUD-### / CMP-### IDs. A report is used only when its period shares at least one day with the
 * strategy's period, and a campaign-scoped report only when the strategy is scoped to campaigns.
 * Never throws: malformed reports are skipped and listed in `ignored`.
 */
export function priorFindings(
  history: AgentHistoryMessage[],
  period: { dateStart: string; dateStop: string },
  scope: { campaignIds?: string[] },
): PriorReports {
  const out: PriorReports = { findings: [], used: [], ignored: [] };
  const strategyScoped = (scope?.campaignIds?.length ?? 0) > 0;
  const kinds: Array<{ kind: Kind; title: RegExp }> = [
    { kind: "audit", title: AUDIT_TITLE },
    { kind: "comparison", title: COMPARISON_TITLE },
  ];
  for (const { kind, title } of kinds) {
    try {
      const msg = (history ?? []).findLast((m) => m.role === "assistant" && title.test(m.content ?? ""));
      if (!msg) continue;
      const text = msg.content;
      const range = kind === "audit" ? auditPeriod(text) : comparisonPeriod(text);
      if (!range) {
        out.ignored.push(`${kind} not used: period not stated`);
        continue;
      }
      const label = `${kind} of ${range.dateStart} → ${range.dateStop}`;
      const parsed = kind === "audit" ? parseAudit(text) : parseComparison(text);
      if (parsed.oldNumbering) {
        out.ignored.push(`${label} not used: uses the old R# numbering`);
        continue;
      }
      if (range.dateStart > period.dateStop || range.dateStop < period.dateStart) {
        out.ignored.push(`${label} not used: different period`);
        continue;
      }
      const reportScoped = kind === "audit" ? auditIsCampaignScoped(text) : comparisonIsCampaignScoped(text);
      if (reportScoped && !strategyScoped) {
        out.ignored.push(`${label} not used: covers specific campaigns, the strategy covers the whole account`);
        continue;
      }
      out.findings.push(...parsed.findings);
      out.used.push(`${label} used`);
    } catch {
      out.ignored.push(`${kind} not used: could not be read`);
    }
  }
  return out;
}
