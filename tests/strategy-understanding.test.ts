import { describe, expect, it } from "vitest";
import { buildClassifierPrompt, SYSTEM } from "@/lib/agent/intent-classifier";
import { normalizeBrief, parseBriefReply, rulesBrief } from "@/lib/agent/request-brief";
import { proposalOptions, strategyState } from "@/lib/agent/strategy-state";
import { resolveStrategyTarget } from "@/lib/agent/account-strategy-brief";
import type { AgentHistoryMessage } from "@/lib/agent/history";

const TABLE = [
  "| Option | Purchases/day (now 0.8) | Budget/day (now $45.02 AUD) | Max cost per purchase | Min ROAS | By |",
  "|---|---|---|---|---|---|",
  "| Safe | 1.1 | $67.53 | $61.91 | 14.60× | 2026-12-17 |",
  "| **Recommended** | **1.3** | **$90.04** | **$67.54** | **13.39×** | **2027-01-01** |",
  "| Bold | 1.8 | $135.06 | $75.98 | 11.90× | 2027-01-16 |",
].join("\n");

const PROPOSAL = [
  "# Strategy — Bethel Shopfitting World",
  "",
  "**What I see**",
  "- The account is profitable and improving.",
  "",
  "**Targets I'd set**",
  "",
  TABLE,
  "",
  "---",
  "**Next:** reply **safe**, **recommended** or **bold** to pick a target for the strategy, or give your own. I'll then write the full plan. Nothing in Meta will be changed.",
].join("\n");

const ACTION_LIST = [
  "Taking \"recommended\" as: give me the prioritised action list from the strategy above, ordered by impact.",
  "",
  "1. **Fix tracking first — install Conversions API (CAPI)**",
  "2. **Add 2–4 new ads to each live ad set**",
].join("\n");

const PLAN = "# Bethel Shopfitting World — strategy to 1.3 purchases a day by 1 Jan 2027\n\n## 1. Strategy header\n**Goal:** …";

const u = (content: string): AgentHistoryMessage => ({ role: "user", content });
const a = (content: string): AgentHistoryMessage => ({ role: "assistant", content });

/** The Bethel chat up to the operator's latest message (17 Nov 2026). */
const BETHEL: AgentHistoryMessage[] = [
  u("i want to know how the account performed for the last 30 days compared with the previous 30 days"),
  a("# Meta Ads Comparison Report — Bethel Shopfitting World\n\n## 0. Report header and data integrity"),
  u("alright now give me a strategy report"),
  a(PROPOSAL),
  u("go with recommended, Our average gross margin is approximately 40%, before advertising costs."),
  a(`Saved to Bethel Shopfitting World's settings: margin 40% (was not set).\n\n---\n\n${PROPOSAL}`),
  u("recommended"),
  a(ACTION_LIST),
];

describe("strategyState", () => {
  it("keeps the proposal open across an off-track reply, until a plan is written", () => {
    const s = strategyState(BETHEL);
    expect(s.open).toBe(true);
    expect(s.messagesAgo).toBe(1);
    expect(strategyState([...BETHEL, u("ok"), a(PLAN)]).open).toBe(false);
    expect(strategyState([u("hi"), a("Hello! How can I help?")]).open).toBe(false);
  });

  it("reads the offered options with their figures", () => {
    expect(proposalOptions(PROPOSAL)).toEqual([
      "Safe — Purchases/day (now 0.8): 1.1, Budget/day (now $45.02 AUD): $67.53, Max cost per purchase: $61.91, Min ROAS: 14.60×, By: 2026-12-17",
      "Recommended — Purchases/day (now 0.8): 1.3, Budget/day (now $45.02 AUD): $90.04, Max cost per purchase: $67.54, Min ROAS: 13.39×, By: 2027-01-01",
      "Bold — Purchases/day (now 0.8): 1.8, Budget/day (now $45.02 AUD): $135.06, Max cost per purchase: $75.98, Min ROAS: 11.90×, By: 2027-01-16",
    ]);
  });

  it("takes the options from the full proposal when the history's copy was cut before the table", () => {
    const cut = [u("strategy"), a("# Strategy — Bethel Shopfitting World\n\n**What I see**\n\n[earlier report truncated]")];
    expect(strategyState(cut, PROPOSAL).options).toHaveLength(3);
  });
});

describe("the classifier is told where the strategy stands", () => {
  it("puts the state and the options in the prompt", () => {
    const prompt = buildClassifierPrompt("lets go with recommended, give me a strategy report", BETHEL);
    expect(prompt).toContain("Conversation state: a strategy is in progress");
    expect(prompt).toContain("Recommended — Purchases/day (now 0.8): 1.3, Budget/day (now $45.02 AUD): $90.04");
    expect(prompt).toContain("1 assistant message ago");
  });

  it("says nothing about a strategy when none is open", () => {
    expect(buildClassifierPrompt("how did last week go?", [u("hi"), a("Hello!")])).not.toContain("Conversation state");
  });

  it("asks the model for the pick and puts strategy before followup", () => {
    expect(SYSTEM).toContain('"strategyPick"');
    expect(SYSTEM).toContain("Strategy beats followup");
  });
});

describe("the model's reading decides", () => {
  const request = "lets go with recommended, give me a strategy report";

  it("a model that understood the pick routes to the strategy", () => {
    const reply = '{"intent":"strategy","mode":"analyse","strategyPick":"recommended"}';
    const brief = normalizeBrief(parseBriefReply(reply, request, BETHEL)!, request, BETHEL);
    expect(brief).toMatchObject({ intent: "strategy", strategyPick: "recommended" });
  });

  it("a pick in words the patterns can't read still works when the model reads it", () => {
    const req = "go for the $90 a day one";
    const reply = '{"intent":"strategy","strategyPick":"recommended"}';
    const brief = normalizeBrief(parseBriefReply(reply, req, BETHEL)!, req, BETHEL);
    expect(brief.strategyPick).toBe("recommended");
    expect(resolveStrategyTarget(req, BETHEL, "sales", undefined, brief.strategyPick).pick).toBe("recommended");
  });

  it("a model that said followup is overruled when the message plainly picks (Bethel, 17 Nov)", () => {
    const reply = '{"intent":"followup","mode":"analyse","strategyPick":null}';
    const brief = normalizeBrief(parseBriefReply(reply, request, BETHEL)!, request, BETHEL);
    expect(brief).toMatchObject({ intent: "strategy", strategyPick: "recommended" });
  });

  it("a pick is ignored when no proposal is waiting", () => {
    const history = [u("hi"), a("Hello!")];
    const reply = '{"intent":"chat","strategyPick":"bold"}';
    expect(normalizeBrief(parseBriefReply(reply, "bold move?", history)!, "bold move?", history).strategyPick ?? null).toBeNull();
  });

  it("a question about the options stays a question", () => {
    const req = "why is the bold option riskier?";
    const reply = '{"intent":"chat","strategyPick":null}';
    expect(normalizeBrief(parseBriefReply(reply, req, BETHEL)!, req, BETHEL).intent).toBe("chat");
  });

  it("without a model, the patterns still catch a plain pick after an off-track reply", () => {
    for (const req of ["recommended", request, "go with bold", "4x ROAS in 60 days"]) {
      const brief = normalizeBrief(rulesBrief(req, BETHEL), req, BETHEL);
      expect(brief.intent, req).toBe("strategy");
    }
  });

  it("the strategy step sees the open proposal even though the last reply was the action list", () => {
    const r = resolveStrategyTarget(request, BETHEL, "sales");
    expect(r).toMatchObject({ answering: true, pick: "recommended" });
  });
});
