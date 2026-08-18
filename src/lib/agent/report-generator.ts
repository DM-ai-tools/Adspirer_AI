import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { getConfig } from "@/lib/config";
import type { AgentHistoryMessage } from "@/lib/agent/history";
import { sanitizeHistoryContent } from "@/lib/agent/reply-format";
import { logger } from "@/lib/observability/logger";

export type GeneratedReport = {
  title: string;
  markdown: string;
  source: "openai" | "heuristic";
};

/**
 * Build an operator report from conversation history + Meta evidence via OpenAI.
 */
export async function generateConversationReport(input: {
  request: string;
  clientContext: string;
  history: AgentHistoryMessage[];
  metaEvidence?: string;
}): Promise<GeneratedReport> {
  const transcript = formatTranscript(input.history);
  const config = getConfig();

  if (config.hasOpenAI && config.OPENAI_API_KEY) {
    try {
      const openai = createOpenAI({ apiKey: config.OPENAI_API_KEY });
      const { text } = await generateText({
        model: openai(config.OPENAI_MODEL),
        temperature: 0.3,
        maxOutputTokens: 3500,
        system: [
          "You write professional Meta Ads operator reports for agency teams.",
          "Use ONLY the provided chat transcript, client context, and Meta evidence.",
          "Do not invent campaign IDs, spend, or results that are not in the evidence.",
          "Output markdown with this structure:",
          "# Title",
          "## Executive summary",
          "## What we covered / decisions",
          "## Account & campaign findings (if evidence exists)",
          "## Actions taken or queued (Approvals)",
          "## Recommendations / next steps",
          "## Open questions",
          "Be concrete and concise. Use bullets. Include IDs/URLs when present.",
          "If evidence is thin, say so clearly.",
        ].join(" "),
        prompt: [
          `Operator request:\n${input.request.slice(0, 1500)}`,
          "",
          "## Client context",
          input.clientContext.slice(0, 4000) || "(none)",
          "",
          "## Live Meta evidence",
          (input.metaEvidence ?? "(none)").slice(0, 10_000),
          "",
          "## Conversation transcript",
          transcript.slice(0, 20_000) || "(no prior chat — report from Meta evidence only)",
        ].join("\n"),
      });

      const markdown = text.trim();
      const title =
        markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ||
        deriveTitle(input.request);
      return {
        title,
        markdown: ensureTitle(markdown, title),
        source: "openai",
      };
    } catch (error) {
      logger.warn("OpenAI report generation failed; using heuristic report", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return buildHeuristicReport(input);
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

function deriveTitle(request: string): string {
  const cleaned = request.replace(/\s+/g, " ").trim().slice(0, 80);
  if (/report/i.test(cleaned)) return "Meta Ops session report";
  return `Adspirer report — ${cleaned || "workspace session"}`;
}

function ensureTitle(markdown: string, title: string): string {
  if (/^#\s+/m.test(markdown)) return markdown;
  return `# ${title}\n\n${markdown}`;
}

function buildHeuristicReport(input: {
  request: string;
  clientContext: string;
  history: AgentHistoryMessage[];
  metaEvidence?: string;
}): GeneratedReport {
  const title = deriveTitle(input.request);
  const decisions = input.history
    .filter((m) => m.role === "user")
    .slice(-8)
    .map((m) => `- ${m.content.replace(/\s+/g, " ").trim().slice(0, 160)}`);
  const assistantNotes = input.history
    .filter((m) => m.role === "assistant")
    .slice(-4)
    .map((m) => sanitizeHistoryContent(m.content).slice(0, 400))
    .filter(Boolean);

  const markdown = [
    `# ${title}`,
    "",
    "## Executive summary",
    "Session report compiled from workspace chat and available Meta evidence.",
    "OpenAI was unavailable, so this is a structured heuristic draft — review before sharing externally.",
    "",
    "## Client context",
    input.clientContext.trim() || "_No client context available._",
    "",
    "## Operator requests in this thread",
    decisions.length ? decisions.join("\n") : "- (none yet)",
    "",
    "## Live Meta evidence",
    input.metaEvidence?.trim() || "_No Meta evidence gathered for this turn._",
    "",
    "## Recent assistant notes",
    assistantNotes.length
      ? assistantNotes.map((n, i) => `### Note ${i + 1}\n${n}`).join("\n\n")
      : "_None._",
    "",
    "## Recommendations / next steps",
    "- Confirm any Approvals still pending.",
    "- Re-run an account audit if metrics are stale.",
    "- Export this report via **Word** / **PDF** under the message.",
    "",
    "## Open questions",
    "- Any campaign creates still waiting on creative (image URL / copy)?",
  ].join("\n");

  return { title, markdown, source: "heuristic" };
}
