import { generateObject, generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { getConfig } from "@/lib/config";
import type { AgentHistoryMessage } from "@/lib/agent/history";
import { sanitizeHistoryContent } from "@/lib/agent/reply-format";
import { logger } from "@/lib/observability/logger";
import {
  AuditReportSchema,
  parseAuditReport,
  tryParseAuditReport,
  type AuditReport,
} from "@/lib/report/schema";
import { renderAuditReportMarkdown } from "@/lib/report/md/AuditReportMd";
import {
  auditReportFromMarkdown,
  looksLikeFullAuditMarkdown,
  withWorkingNotes,
} from "@/lib/report/from-markdown";

export type GeneratedStructuredReport = {
  title: string;
  markdown: string;
  report: AuditReport;
  source: "openai" | "heuristic" | "chat_audit";
};

const REPORT_SYSTEM = `You convert a completed ad-account audit / Meta ops session into a structured report object.
Rules:
- Fill EVERY field. If a value is genuinely unavailable, use the literal string "No data"
  and add an entry to dataNotes explaining why. Never invent numbers.
- Prefer figures from the conversation transcript audit over inventing inventory-only stubs.
- bottomLine: 2-3 sentences, max 60 words. Lead with the verdict, then the single
  biggest exposure, then the first action. No preamble, no "Here's the full audit".
- kpis: exactly 4, ordered by what the reader checks first. Set flag=true on any KPI
  whose value is missing or breaching a threshold.
- BulletSchema.lead is a short bolded clause (2-6 words); body continues the sentence
  and must NOT repeat the lead.
- risks: severity high only when it blocks spend or wastes budget today. Include all material risks from the audit.
- recommendations: ordered by impact, up to 10, each independently actionable.
- Write in plain sentences. No markdown syntax anywhere in any field.
- meta.generatedAt must be an ISO timestamp.
- campaign status must be ACTIVE, PAUSED, or ARCHIVED.
- spendSharePct is a 0-100 number or null when spend is unknown.
- campaigns[].metrics should include Spend, Impressions, Clicks, CTR, CPC when known.`;

/**
 * Build a validated AuditReport (JSON) from chat + Meta evidence, then derive markdown.
 */
export async function generateStructuredAuditReport(input: {
  request: string;
  clientContext: string;
  history: AgentHistoryMessage[];
  metaEvidence?: string;
}): Promise<GeneratedStructuredReport> {
  const transcript = formatTranscript(input.history);

  // Prefer a full audit already written in chat — this is what operators download.
  const fromChat = reportFromChatHistory(input.history);
  if (fromChat) {
    const title = `${fromChat.meta.reportType} — ${fromChat.meta.accountName}`;
    return {
      title,
      markdown: renderAuditReportMarkdown(fromChat),
      report: fromChat,
      source: "chat_audit",
    };
  }

  const config = getConfig();

  if (config.hasOpenAI && config.OPENAI_API_KEY) {
    try {
      const openai = createOpenAI({ apiKey: config.OPENAI_API_KEY });
      const { object } = await generateObject({
        model: openai(config.OPENAI_MODEL),
        schema: AuditReportSchema,
        temperature: 0.2,
        system: REPORT_SYSTEM,
        prompt: [
          `Operator request:\n${input.request.slice(0, 1500)}`,
          "",
          "## Client context",
          input.clientContext.slice(0, 4000) || "(none)",
          "",
          "## Live Meta evidence",
          (input.metaEvidence ?? "(none)").slice(0, 12_000),
          "",
          "## Conversation transcript",
          transcript.slice(0, 18_000) || "(no prior chat)",
          "",
          `Use generatedAt = ${new Date().toISOString()} unless evidence specifies otherwise.`,
        ].join("\n"),
      });

      const report = parseAuditReport(object);
      const title = `${report.meta.reportType} — ${report.meta.accountName}`;
      return {
        title,
        markdown: renderAuditReportMarkdown(report),
        report,
        source: "openai",
      };
    } catch (error) {
      logger.warn("generateObject audit report failed; trying JSON text", {
        error: error instanceof Error ? error.message : String(error),
      });
      try {
        const openai = createOpenAI({ apiKey: config.OPENAI_API_KEY });
        const { text } = await generateText({
          model: openai(config.OPENAI_MODEL),
          temperature: 0.2,
          system: `${REPORT_SYSTEM}\nReturn ONLY valid JSON matching the audit report schema.`,
          prompt: [
            `Operator request:\n${input.request.slice(0, 1500)}`,
            "",
            "## Live Meta evidence",
            (input.metaEvidence ?? "(none)").slice(0, 12_000),
            "",
            "## Conversation transcript",
            transcript.slice(0, 18_000) || "(no prior chat)",
          ].join("\n"),
        });
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        const parsed = jsonMatch
          ? tryParseAuditReport(JSON.parse(jsonMatch[0]))
          : null;
        if (parsed) {
          return {
            title: `${parsed.meta.reportType} — ${parsed.meta.accountName}`,
            markdown: renderAuditReportMarkdown(parsed),
            report: parsed,
            source: "openai",
          };
        }
      } catch (inner) {
        logger.warn("JSON text audit report failed; using heuristic", {
          error: inner instanceof Error ? inner.message : String(inner),
        });
      }
    }
  }

  const report = buildHeuristicAuditReport(input);
  return {
    title: `${report.meta.reportType} — ${report.meta.accountName}`,
    markdown: renderAuditReportMarkdown(report),
    report,
    source: "heuristic",
  };
}

function reportFromChatHistory(
  history: AgentHistoryMessage[],
): AuditReport | null {
  const assistants = history
    .filter((m) => m.role === "assistant")
    .map((m) => sanitizeHistoryContent(m.content))
    .filter((c) => looksLikeFullAuditMarkdown(c));
  const latest = assistants.at(-1);
  if (!latest) return null;
  const parsed = auditReportFromMarkdown(latest);
  return parsed ? withWorkingNotes(parsed, latest) : null;
}

function formatTranscript(history: AgentHistoryMessage[]): string {
  return history
    .map((m) => {
      const role = m.role.toUpperCase();
      const body =
        m.role === "assistant" ? sanitizeHistoryContent(m.content) : m.content;
      return `### ${role}\n${body.trim()}`;
    })
    .join("\n\n")
    .slice(0, 24_000);
}

function extract(pattern: RegExp, text: string): string | null {
  return pattern.exec(text)?.[1]?.trim() ?? null;
}

function buildHeuristicAuditReport(input: {
  request: string;
  clientContext: string;
  history: AgentHistoryMessage[];
  metaEvidence?: string;
}): AuditReport {
  const fromChat = reportFromChatHistory(input.history);
  if (fromChat) return fromChat;

  const evidence = `${input.metaEvidence ?? ""}\n${formatTranscript(input.history)}`;
  const fromEvidence = auditReportFromMarkdown(evidence);
  if (fromEvidence) return fromEvidence;

  const accountName =
    extract(/Name:\s*(.+)/i, evidence) ||
    extract(/account[_\s-]?name[:\s]+(.+)/i, input.clientContext) ||
    "Meta ad account";
  const accountId =
    extract(/ID:\s*(act_\d+)/i, evidence) ||
    extract(/(act_\d+)/i, evidence) ||
    "No data";
  const currency = extract(/Currency:\s*(\w+)/i, evidence) || "USD";
  const timezone = extract(/TZ:\s*(.+)/i, evidence) || "UTC";
  const active = extract(/(\d+)\s+active/i, evidence);
  const paused = extract(/(\d+)\s+paused/i, evidence);
  const total = extract(/Campaigns:\s*(\d+)/i, evidence);

  const period =
    extract(/Period:\s*(.+)/i, evidence) ||
    extract(/last\s+(\d+\s+days)/i, input.request) ||
    "Session window";

  const campaignBlocks = [
    ...evidence.matchAll(
      /^-\s+(.+?)\s+\((\d+)\)\s+·\s+(\w+)\s+·\s+(\S+)/gm,
    ),
  ].slice(0, 12);

  const campaigns = campaignBlocks.map((m) => ({
    name: m[1],
    id: m[2],
    status: (["ACTIVE", "PAUSED", "ARCHIVED"].includes(m[3])
      ? m[3]
      : "PAUSED") as "ACTIVE" | "PAUSED" | "ARCHIVED",
    objective: m[4],
    spendSharePct: null as number | null,
    deliverySignals: [
      {
        lead: "Listed in inventory",
        body: "Pulled from live Meta campaign list for this session.",
      },
    ],
    risks: [],
    checkedAgainst: ["Campaign inventory"],
  }));

  return parseAuditReport({
    meta: {
      reportType: "Meta Ads Account Audit",
      subtitle:
        "Operator review of live delivery, risk and next actions",
      accountName,
      accountId,
      platform: "meta",
      period,
      generatedAt: new Date().toISOString(),
      currency,
      timezone,
    },
    healthScore: null,
    healthLabel: "Needs attention",
    bottomLine:
      "Structured OpenAI generation was unavailable, so this is a heuristic draft from live evidence. Confirm metrics in Ads Manager before acting, then ask to optimize specific campaigns when ready.",
    kpis: [
      {
        label: "Total campaigns",
        value: total ?? String(campaigns.length || "No data"),
        flag: !total,
      },
      {
        label: "Active",
        value: active ?? "No data",
        flag: !active,
      },
      {
        label: "Paused",
        value: paused ?? "No data",
        flag: !paused,
      },
      {
        label: "Period spend",
        value: "No data",
        note: "Run a dated audit for spend",
        flag: true,
      },
    ],
    snapshot: [
      { label: "Account", value: accountName },
      { label: "Account ID", value: accountId, mono: true },
      { label: "Currency", value: currency },
      { label: "Timezone", value: timezone },
      { label: "Period", value: period },
      {
        label: "Source",
        value: "Heuristic draft (OpenAI structured output unavailable)",
      },
    ],
    dataNotes: [
      "This draft was assembled without structured LLM output — treat figures as provisional.",
    ],
    campaigns,
    risks: [
      {
        title: "Incomplete spend visibility",
        severity: "medium",
        detail:
          "Period spend / CPA were not fully resolved in this heuristic pass. Re-run a dated account audit for full metrics.",
      },
    ],
    recommendations: [
      {
        title: "Re-run dated audit",
        detail:
          "Ask for an account audit with an explicit date range so spend, delivery, and risks populate from live insights.",
        impact: "high",
        effort: "2 min",
        tags: ["measurement"],
      },
      {
        title: "Confirm Approvals",
        detail:
          "Check Approvals for any paused creates still waiting on review before scaling.",
        impact: "medium",
        effort: "5 min",
        tags: ["ops"],
      },
    ],
    methodology:
      "Compiled from workspace chat transcript and available Meta diagnose evidence when structured report generation was unavailable.",
  });
}
