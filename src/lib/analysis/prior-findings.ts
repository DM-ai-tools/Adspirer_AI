import { parseDateRangeFromText } from "@/lib/agent/audit-brief";
import type { AgentHistoryMessage } from "@/lib/agent/history";

export type PriorFinding = { id: string; title: string; evidence: string | null; source: "audit" | "comparison" };
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

/** Comparison period: the "Current:" line of section 0 (before the next heading), up to ";" or "Previous". */
function comparisonPeriod(text: string): { dateStart: string; dateStop: string } | null {
  const section0 = text.match(/^##\s*0\.[^\n]*\n([\s\S]*?)(?=^##\s|\s*$(?![\s\S]))/m)?.[1] ?? "";
  const line = section0.match(/\bCurrent(?:\s+window)?\s*\**\s*:\**\s*([^\n]+)/i)?.[1];
  if (!line) return null;
  return readRange(line.split(/;|\bPrevious\b|\bvs\.?\b/i)[0]);
}

/**
 * Campaign-scoped = the header says so. Audit: a "Scope:" value or "Campaigns:" line naming
 * selected / specific campaigns, or "campaign audit" wording. Comparison: the section-0 "Scope" line
 * (written only when the run covered some campaigns). Anything undeterminable is whole-account.
 */
const SCOPED_WORDING = /\b(?:selected|specific|chosen|named)\s+campaigns?\b|\bcampaign\s+audit\b|\bonly\s+(?:the\s+)?(?:selected\s+)?campaigns?\b|\bnot\s+only\b/i;

function auditIsCampaignScoped(text: string): boolean {
  const header = text.slice(0, 2_000);
  const scope = header.match(/\*\*Scope:?\*\*:?\s*([^\n]+)/)?.[1] ?? "";
  if (scope) return SCOPED_WORDING.test(scope) || (!/\b(?:entire|whole|all)\b/i.test(scope) && /\bcampaigns?\b/i.test(scope));
  return /^\s*[-*]?\s*\**Campaigns?:\**\s*\S/m.test(header) || /\bcampaign\s+audit\b/i.test(header);
}

function comparisonIsCampaignScoped(text: string): boolean {
  const section0 = text.match(/^##\s*0\.[^\n]*\n([\s\S]*?)(?=^##\s|\s*$(?![\s\S]))/m)?.[1] ?? "";
  const scope = section0.match(/\*\*Scope\*\*\s*:?\s*([^\n]+)/i)?.[1] ?? section0.match(/^\s*[-*]?\s*Scope\s*:\s*([^\n]+)/im)?.[1] ?? "";
  if (!scope) return false;
  return SCOPED_WORDING.test(scope) || (!/\b(?:entire|whole|all)\b/i.test(scope) && /\bcampaigns?\b/i.test(scope));
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
