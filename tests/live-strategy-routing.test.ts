import fs from "node:fs";
import { describe, expect, it } from "vitest";
import type { AgentHistoryMessage } from "@/lib/agent/history";

/**
 * LIVE check of the request classifier against the real model: does the workspace understand an
 * operator's reply to a strategy in context? Off by default (it calls the AI provider and costs a
 * few cents). Run with:  RUN_LIVE_EVAL=1 npx vitest run tests/live-strategy-routing.test.ts
 */

const LIVE = process.env.RUN_LIVE_EVAL === "1";

const TABLE = [
  "| Option | Purchases/day (now 0.8) | Budget/day (now $45.02 AUD) | Max cost per purchase | Min ROAS | By |",
  "|---|---|---|---|---|---|",
  "| Safe | 1.1 | $67.53 | $61.91 | 14.60× | 2026-12-17 |",
  "| **Recommended** | **1.3** | **$90.04** | **$67.54** | **13.39×** | **2027-01-01** |",
  "| Bold | 1.8 | $135.06 | $75.98 | 11.90× | 2027-01-16 |",
].join("\n");
const PROPOSAL = `# Strategy — Bethel Shopfitting World\n\n**What I see**\n- The account is profitable and improving: ROAS 16.06×, 24 purchases.\n\n**Targets I'd set**\n\n${TABLE}\n\nThe **recommended** option doubles the daily budget over 45 days.\n\n---\n**Next:** reply **safe**, **recommended** or **bold** to pick a target for the strategy, or give your own (for example \`4x ROAS in 60 days\`). I'll then write the full plan. Nothing in Meta will be changed.`;
const COMPARISON = "# Meta Ads Comparison Report — Bethel Shopfitting World\n\n## 0. Report header and data integrity\n- **Current:** 2026-10-18 → 2026-11-16 (30 days)\n\n## 1. Executive summary\n- CPM fell 13.0%; purchases 13 → 24 (Low volume).";
const ACTION_LIST = 'Taking "recommended" as: give me the prioritised action list from the strategy above, ordered by impact.\n\n1. **Install Conversions API (CAPI)**\n2. **Add 2–4 new ads to each live ad set**\n3. **Consolidate spend toward high-efficiency placements**\n\nSteps 2, 3 and 4 are queueable here — ask me to queue any of them when you\'re ready.';
const PLAN = "# Bethel Shopfitting World — strategy to 1.3 purchases a day by 1 Jan 2027\n\n## 1. Strategy header\n**Goal:** 1.3 purchases a day…\n\n## 6. Action plan\n| ID | Action | Owner | Type | Timing | Effort |";

const u = (content: string): AgentHistoryMessage => ({ role: "user", content });
const a = (content: string): AgentHistoryMessage => ({ role: "assistant", content });

/** The proposal is the assistant's last message. */
const FRESH = [u("compare last 30 days"), a(COMPARISON), u("alright now give me a strategy report"), a(PROPOSAL)];
/** The real Bethel chat: the proposal is open but an off-track action list came after it. */
const BETHEL = [...FRESH, u("recommended"), a(ACTION_LIST)];
/** A report, no strategy yet. */
const REPORT_ONLY = [u("compare last 30 days"), a(COMPARISON)];
/** The plan has been written. */
const PLANNED = [...FRESH, u("recommended"), a(PLAN)];

type Case = { history: AgentHistoryMessage[]; label: string; message: string; intent: string[]; pick: string | null };
const CASES: Case[] = [
  // Replies right after the proposal.
  { history: FRESH, label: "fresh", message: "recommended", intent: ["strategy"], pick: "recommended" },
  { history: FRESH, label: "fresh", message: "go with the middle one", intent: ["strategy"], pick: "recommended" },
  { history: FRESH, label: "fresh", message: "the safe one please", intent: ["strategy"], pick: "safe" },
  { history: FRESH, label: "fresh", message: "let's be ambitious and go big", intent: ["strategy"], pick: "bold" },
  { history: FRESH, label: "fresh", message: "go for the $90 a day one", intent: ["strategy"], pick: "recommended" },
  { history: FRESH, label: "fresh", message: "yes, go ahead with your pick", intent: ["strategy"], pick: "recommended" },
  { history: FRESH, label: "fresh", message: "recommended, and our margin is 40%", intent: ["strategy"], pick: "recommended" },
  { history: FRESH, label: "fresh", message: "4x ROAS in 60 days instead", intent: ["strategy"], pick: "own" },
  { history: FRESH, label: "fresh", message: "aim for $60 per purchase by end of January", intent: ["strategy"], pick: "own" },
  { history: FRESH, label: "fresh", message: "option 3", intent: ["strategy"], pick: "bold" },
  { history: FRESH, label: "fresh", message: "why is bold riskier?", intent: ["chat", "general", "followup"], pick: null },
  { history: FRESH, label: "fresh", message: "what does min ROAS mean here?", intent: ["chat", "general", "followup"], pick: null },
  { history: FRESH, label: "fresh", message: "how did you work out the $90 budget?", intent: ["chat", "general", "followup"], pick: null },
  // The Bethel chat: an off-track reply came after the proposal.
  { history: BETHEL, label: "bethel", message: "lets go with recommended, give me a strategy report", intent: ["strategy"], pick: "recommended" },
  { history: BETHEL, label: "bethel", message: "recommended", intent: ["strategy"], pick: "recommended" },
  { history: BETHEL, label: "bethel", message: "no, I want the full strategy plan with the recommended target", intent: ["strategy"], pick: "recommended" },
  { history: BETHEL, label: "bethel", message: "that's not what I asked, write the strategy for the safe option", intent: ["strategy"], pick: "safe" },
  { history: BETHEL, label: "bethel", message: "queue step 2", intent: ["optimize"], pick: null },
  { history: BETHEL, label: "bethel", message: "thanks", intent: ["chat"], pick: null },
  { history: FRESH, label: "fresh", message: "great, thanks", intent: ["chat"], pick: null },
  { history: FRESH, label: "fresh", message: "ok go ahead", intent: ["strategy"], pick: "recommended" },
  // A report but no strategy yet.
  { history: REPORT_ONLY, label: "report", message: "give me a strategy report", intent: ["strategy"], pick: null },
  { history: REPORT_ONLY, label: "report", message: "now build me a growth plan from this", intent: ["strategy"], pick: null },
  { history: REPORT_ONLY, label: "report", message: "based on the comparison, what should I fix first?", intent: ["followup", "optimize"], pick: null },
  { history: REPORT_ONLY, label: "report", message: "explain the CVR driver", intent: ["followup", "chat", "general"], pick: null },
  // The plan is written: no pick is waiting.
  { history: PLANNED, label: "planned", message: "explain STR-003", intent: ["followup", "chat", "general"], pick: null },
  { history: PLANNED, label: "planned", message: "redo the plan with the bold target", intent: ["strategy"], pick: null },
  { history: PLANNED, label: "planned", message: "queue STR-002", intent: ["optimize"], pick: null },
];

type ScopeCase = { history: AgentHistoryMessage[]; message: string; campaigns: string[]; perCampaign: boolean };
const SCOPE_CASES: ScopeCase[] = [
  { history: REPORT_ONLY, message: "give me a strategy for each campaign", campaigns: [], perCampaign: true },
  { history: REPORT_ONLY, message: "strategy report, broken down campaign by campaign", campaigns: [], perCampaign: true },
  { history: REPORT_ONLY, message: "build a strategy for the Basket and Retail Display campaign", campaigns: ["Basket and Retail Display"], perCampaign: false },
  { history: REPORT_ONLY, message: "give me a strategy report", campaigns: [], perCampaign: false },
  { history: [...REPORT_ONLY, u("give me a strategy for each campaign"), a(PROPOSAL)], message: "recommended", campaigns: [], perCampaign: true },
];

const STOPPED = a(
  "# Bethel Shopfitting World — strategy to 1.3 purchases a day by 1 Jan 2027\n\n## 1. Strategy header\n**Goal:** 1.3 purchases a day\n\n## 2. Situation summary\nThe account is profitable and\n\n_Stopped before the reply finished. Type “continue” to resume, or say what to change._",
);
/** The plan was stopped midway; the operator now types. */
const AFTER_STOP = [...FRESH, u("recommended"), STOPPED];
type ResumeCase = { message: string; resumes: boolean };
const RESUME_CASES: ResumeCase[] = [
  { message: "continue", resumes: true },
  { message: "ok go on", resumes: true },
  { message: "continue but break it down for each campaign", resumes: true },
  { message: "resume, and keep it shorter", resumes: true },
  { message: "carry on but use the bold target instead", resumes: true },
  { message: "actually, show me last week's spend by campaign", resumes: false },
  { message: "how is the account doing today?", resumes: false },
];

function loadAiEnv() {
  const env = fs.readFileSync(".env.local", "utf8");
  for (const line of env.split(/\r?\n/)) {
    const m = /^(OPENAI_API_KEY|OPENAI_MODEL|ANTHROPIC_API_KEY|ANTHROPIC_MODEL)=(.*)$/.exec(line);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

describe.skipIf(!LIVE)("LIVE: strategy replies are understood in context", () => {
  it(
    "routes every case as expected",
    async () => {
      loadAiEnv();
      const { resetConfigCache } = await import("@/lib/config");
      resetConfigCache();
      const { classifyRequest } = await import("@/lib/agent/intent-classifier");
      const wrong: string[] = [];
      for (const c of CASES) {
        const brief = await classifyRequest(c.message, c.history, c.history.includes(a(PROPOSAL)) ? PROPOSAL : null);
        const pick = brief.strategyPick ?? null;
        // The intent must match; a pick, when one is expected, must match; no pick may be taken from a non-strategy message.
        const ok =
          c.intent.includes(brief.intent) &&
          (c.pick === null ? brief.intent !== "strategy" || c.intent[0] === "strategy" : pick === c.pick) &&
          (c.intent[0] === "strategy" || pick === null);
        const line = `${ok ? "ok  " : "FAIL"} [${c.label}] "${c.message}" -> ${brief.intent}${pick ? ` (${pick})` : ""}  expected ${c.intent.join("|")}${c.pick ? ` (${c.pick})` : ""}  via ${brief.source}`;
        console.log(line);
        if (!ok) wrong.push(line);
      }
      expect(wrong).toEqual([]);
    },
    300_000,
  );

  it(
    "knows when a message resumes a stopped reply",
    async () => {
      loadAiEnv();
      const { resetConfigCache } = await import("@/lib/config");
      resetConfigCache();
      const { classifyRequest } = await import("@/lib/agent/intent-classifier");
      const wrong: string[] = [];
      for (const c of RESUME_CASES) {
        const brief = await classifyRequest(c.message, AFTER_STOP, PROPOSAL);
        const ok = Boolean(brief.resumesStopped) === c.resumes;
        const line = `${ok ? "ok  " : "FAIL"} [stopped] "${c.message}" -> resumes=${Boolean(brief.resumesStopped)} intent=${brief.intent}  expected resumes=${c.resumes}`;
        console.log(line);
        if (!ok) wrong.push(line);
      }
      expect(wrong).toEqual([]);
    },
    300_000,
  );

  it(
    "reads what the strategy should cover",
    async () => {
      loadAiEnv();
      const { resetConfigCache } = await import("@/lib/config");
      resetConfigCache();
      const { classifyRequest } = await import("@/lib/agent/intent-classifier");
      const wrong: string[] = [];
      for (const c of SCOPE_CASES) {
        const brief = await classifyRequest(c.message, c.history, c.history.includes(a(PROPOSAL)) ? PROPOSAL : null);
        const scope = brief.strategyScope ?? { campaigns: [], perCampaign: false };
        const ok =
          brief.intent === "strategy" &&
          scope.perCampaign === c.perCampaign &&
          scope.campaigns.length === c.campaigns.length &&
          c.campaigns.every((n) => scope.campaigns.some((s) => s.toLowerCase().includes(n.toLowerCase())));
        const line = `${ok ? "ok  " : "FAIL"} "${c.message}" -> ${brief.intent} ${JSON.stringify(scope)}  expected ${JSON.stringify({ campaigns: c.campaigns, perCampaign: c.perCampaign })}`;
        console.log(line);
        if (!ok) wrong.push(line);
      }
      expect(wrong).toEqual([]);
    },
    300_000,
  );
});
