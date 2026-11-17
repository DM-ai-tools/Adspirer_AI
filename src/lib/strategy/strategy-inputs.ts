import type { AgentHistoryMessage } from "@/lib/agent/history";
import { CAPABILITIES } from "@/lib/agent/optimization-capabilities";
import { priorFindings, type PriorFinding } from "@/lib/analysis/prior-findings";
import { measurementBreaks, measurementCaveats } from "@/lib/analysis/measurement";
import { businessTypeOf } from "@/lib/analysis/shared-rules";
import type { AuditScorecard, CheckpointSeverity } from "@/lib/audit/checkpoints";
import type { MetaAuditSnapshot } from "@/lib/audit/meta-audit-data";
import type { ResolvedGoals } from "@/lib/clients/goals";
import { PLATFORM_NOTES_VERSION, platformNotes } from "@/lib/strategy/platform-notes";
import { resolveProfile } from "@/lib/strategy/profile-resolution";

export const NO_PRIOR_REPORT_NOTICE =
  "No audit or comparison in this chat covers this period; findings below come from this strategy's own checks (SF-###)";

type Money = (cents: number) => string;
const defaultMoney: Money = (c) => (c / 100).toFixed(2);

/** `tool` is for code only; the writer never sees it (the reader never sees tool names or setting keys). */
export type AppAction = { capabilityId: string; label: string; tool: string; note: string; guardrail: string };

/** What this app can do through Approvals (Type A), with the limits the client's goals set. */
export function appActions(goals: ResolvedGoals, money: Money = defaultMoney): AppAction[] {
  const limits: string[] = [`budget changes at most ±${goals.max_budget_change_pct}% per step`];
  if (goals.daily_account_cap_cents != null) limits.push(`account daily cap ${money(goals.daily_account_cap_cents)} per day`);
  if (goals.monthly_cap_cents != null) limits.push(`monthly cap ${money(goals.monthly_cap_cents)} per month`);
  const budgetGuardrail = limits.join("; ");
  return CAPABILITIES.filter((c) => c.owner === "app" && c.tool && !c.queuedFrom).map((c) => ({
    capabilityId: c.id,
    label: c.label,
    tool: c.tool as string,
    note: c.note,
    guardrail: c.focus === "budget" && /budget/.test(c.id) ? budgetGuardrail : "queued in Approvals; an admin approves",
  }));
}

const SEVERITY_RANK: Record<CheckpointSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** The strategy never shows checkpoint codes ("T4"); drop them from the words the writer sees. */
function stripCodes(text: string, ids: string[]): string {
  let out = text;
  for (const id of ids) out = out.replace(new RegExp(`\\(\\s*${id}\\s*\\)|\\b${id}\\b:?`, "g"), "");
  return out.replace(/\s{2,}/g, " ").replace(/\s+([,.;:])/g, "$1").trim();
}

/** Failed checkpoints as SF-### findings, most severe first (ties keep the scorecard's order). */
export function ownFindings(scorecard: AuditScorecard): PriorFinding[] {
  const ids = [...new Set(scorecard.checkpoints.map((c) => c.id))];
  return scorecard.checkpoints
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.status === "fail")
    .sort((a, b) => SEVERITY_RANK[a.c.severity] - SEVERITY_RANK[b.c.severity] || a.i - b.i)
    .map(({ c }, n) => ({
      id: `SF-${String(n + 1).padStart(3, "0")}`,
      title: stripCodes(c.title, ids),
      evidence: c.evidence ? stripCodes(c.evidence, ids) : null,
      source: "strategy" as const,
    }));
}

export function renderStrategyInputsEvidence(input: {
  snapshot: MetaAuditSnapshot;
  goals: ResolvedGoals;
  scorecard: AuditScorecard;
  request: string;
  history: AgentHistoryMessage[];
  /** The latest audit and comparison replies in full; `history` truncates them past their findings. */
  reports?: AgentHistoryMessage[];
  period: { dateStart: string; dateStop: string };
  scope?: { campaignIds?: string[] };
  money?: Money;
  /** The client's saved services or categories: the first answer to "what do they sell". */
  services?: string[];
}): string {
  const { snapshot, goals, scorecard, request, history, period } = input;
  const money = input.money ?? defaultMoney;
  const prior = priorFindings(input.reports ?? history, period, input.scope ?? {});
  const lines: string[] = ["### Strategy inputs (findings, profile, platform notes, app capabilities)", ""];

  const businessType = businessTypeOf(snapshot, goals.business_model);
  lines.push(`**Business type:** ${businessType}`, "");

  lines.push("**Findings (cite these IDs):**");
  for (const u of prior.used) lines.push(`- ${u}`);
  for (const i of prior.ignored) lines.push(`- ${i}`);
  let findings = prior.findings;
  if (findings.length === 0) {
    lines.push(`- ${NO_PRIOR_REPORT_NOTICE}`);
    findings = ownFindings(scorecard);
  }
  if (findings.length === 0) lines.push("- No failed checks.");
  for (const f of findings) lines.push(`- ${f.id} — ${f.title}${f.evidence ? ` — ${f.evidence}` : ""}`);
  lines.push("");

  const known: string[] = [];
  if (goals.business_model) known.push(`business model: ${goals.business_model}`);
  if (goals.target_cpa_cents != null) known.push(`target cost per result: ${money(goals.target_cpa_cents)}`);
  // Lead generation never plans on ROAS or order value, so they are not offered to the writer.
  if (businessType !== "leadgen") {
    if (goals.target_roas != null) known.push(`target ROAS: ${goals.target_roas}`);
    if (goals.average_value_cents != null) known.push(`average order value: ${money(goals.average_value_cents)}`);
  }
  if (goals.gross_margin_pct != null) known.push(`gross margin: ${goals.gross_margin_pct}%`);
  if (goals.daily_account_cap_cents != null) known.push(`account daily cap: ${money(goals.daily_account_cap_cents)} per day`);
  if (goals.monthly_cap_cents != null) known.push(`monthly cap: ${money(goals.monthly_cap_cents)} per month`);
  if (goals.allowed_countries?.length) known.push(`countries: ${goals.allowed_countries.join(", ")}`);
  if (goals.compliance_notes) known.push(`compliance notes: ${goals.compliance_notes}`);
  lines.push("**Profile known:**");
  lines.push(...(known.length ? known.map((k) => `- ${k}`) : ["- Nothing saved yet."]), "");

  // Ask as little as possible: what the chat or the account already answers is stated as an assumption.
  const profile = resolveProfile({ snapshot, goals, request, history, money, services: input.services });
  if (profile.stated.length) {
    lines.push("**Stated by the operator in chat (use their words; don't ask again):**");
    lines.push(...profile.stated.map((s) => `- ${s}`), "");
  }
  lines.push("**Profile from the account's data (list under Assumptions with its source; don't ask):**");
  lines.push(...(profile.fromData.length ? profile.fromData.map((p) => `- ${p.item}: ${p.value} (from ${p.source})`) : ["- None."]), "");
  lines.push("**Profile assumed by default (list under Assumptions; don't ask):**");
  lines.push(...(profile.assumed.length ? profile.assumed.map((p) => `- ${p.item}: ${p.value}`) : ["- None."]), "");
  lines.push("**Questions for the client (ask only these; never save the answers):**");
  lines.push(...(profile.ask.length ? profile.ask.map((q) => `- ${q.item}: ${q.question} — why: ${q.why}`) : ["- None."]), "");

  lines.push("**Measurement:**");
  const breaks = measurementBreaks(snapshot);
  const caveats = measurementCaveats(snapshot);
  for (const b of breaks) lines.push(`- ${b.date} (${b.window} window): ${b.what}${b.objectName ? ` on ${b.objectName}` : ""}`);
  for (const c of caveats) lines.push(`- ${c}`);
  if (!breaks.length && !caveats.length) lines.push("- No attribution or tracking edits found in the activity history.");
  lines.push("");

  lines.push(`**Platform notes (version ${PLATFORM_NOTES_VERSION}):**`);
  for (const n of platformNotes(goals)) lines.push(`- ${n}`);
  lines.push("");

  lines.push("**App capabilities (Type A, done here through Approvals):**");
  for (const a of appActions(goals, money)) lines.push(`- ${a.label} — ${a.note} — ${a.guardrail}`);
  return lines.join("\n");
}
