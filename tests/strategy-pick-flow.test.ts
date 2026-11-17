import { afterEach, describe, expect, it } from "vitest";
import { gatherDiagnoseEvidence } from "@/lib/agent/adspirer-agent";
import { answersTargetProposal, pickedOption, resolveStrategyTarget } from "@/lib/agent/account-strategy-brief";
import { loadConversationHistory, loadLatestReports } from "@/lib/agent/history";
import { normalizeBrief, rulesBrief } from "@/lib/agent/request-brief";
import { getDemoStore, resetDemoStore } from "@/lib/demo/store";
import type { Message } from "@/types";

/**
 * The Bethel Shopfitting World chat (17 Nov 2026): the operator picked "recommended" twice and never got
 * the plan. The current turn's empty assistant row (saved before the reply is written) was loaded as
 * "Done — let me know what you'd like next.", so it looked like the assistant's last message and the
 * real target proposal was no longer "the last thing asked".
 */

const PROPOSAL = [
  "# Strategy — Bethel Shopfitting World",
  "",
  "**What I see**",
  ...Array.from({ length: 30 }, (_, i) => `- Finding line ${i + 1} with enough words to make the proposal long like the real one did.`),
  "",
  "**Questions for the client**",
  "",
  "- **What is your gross margin on a typical order?** Average order value is $903.97 AUD.",
  "",
  "---",
  "**Next:** reply **safe**, **recommended** or **bold** to pick a target for the strategy, or give your own (for example `4x ROAS in 60 days` or `$40 per purchase in 45 days`). I'll then write the full plan. Nothing in Meta will be changed.",
].join("\n");

let clock = Date.parse("2026-11-17T09:58:00Z");
function say(conversationId: string, role: Message["role"], content: string, metadata: Message["metadata"] = null) {
  getDemoStore().messages.push({
    id: `msg_${Math.random().toString(36).slice(2, 10)}`,
    conversation_id: conversationId,
    role,
    content,
    tool_call_id: null,
    metadata,
    created_at: new Date((clock += 1000)).toISOString(),
  } as Message);
}

/** The chat as the task runner loads it during the operator's reply: their message, then the empty row for this reply. */
async function historyDuringReply(conv: string, reply: string) {
  say(conv, "user", "alright now give me a strategy report");
  say(conv, "assistant", PROPOSAL);
  say(conv, "user", reply);
  say(conv, "assistant", "", { status: "running", streaming: true } as Message["metadata"]);
  const loaded = await loadConversationHistory(conv);
  // task-runner drops the operator's own message from the end of the history.
  if (loaded.at(-1)?.role === "user") loaded.pop();
  return loaded;
}

describe("a reply to the strategy's target proposal", () => {
  afterEach(() => resetDemoStore());

  it("loads history without the empty row of the reply being written", async () => {
    const history = await historyDuringReply("conv_pick_1", "recommended");
    const last = history.at(-1)!;
    expect(last.role).toBe("assistant");
    expect(last.content).toContain("pick a target for the strategy");
    expect(history.map((m) => m.content).join("\n")).not.toContain("Done — let me know what you'd like next.");
  });

  it("keeps the whole proposal (it is the latest reply, not an older one cut to 1,500 characters)", async () => {
    const history = await historyDuringReply("conv_pick_2", "recommended");
    expect(PROPOSAL.length).toBeGreaterThan(1_500);
    expect(history.at(-1)!.content).toContain("What is your gross margin on a typical order?");
  });

  it.each([
    "recommended",
    "go with recommended, Our average gross margin is approximately 40%, before advertising costs. Please use this to develop the recommended strategy.",
  ])("takes the pick: %s", async (reply) => {
    const history = await historyDuringReply(`conv_pick_${reply.length}`, reply);
    expect(answersTargetProposal(history)).toBe(true);
    expect(resolveStrategyTarget(reply, history, "sales").pick).toBe("recommended");
  });

  it("routes a pick to the strategy even when the model calls it a follow-up", async () => {
    const history = await historyDuringReply("conv_pick_route", "recommended");
    for (const modelIntent of ["followup", "chat", "general", "custom"] as const) {
      const brief = normalizeBrief({ ...rulesBrief("recommended", history), intent: modelIntent }, "recommended", history);
      expect(brief.intent).toBe("strategy");
    }
  });

  it("routes an own target given in reply to the proposal to the strategy", async () => {
    const history = await historyDuringReply("conv_pick_own", "4x ROAS in 60 days");
    const brief = normalizeBrief({ ...rulesBrief("4x ROAS in 60 days", history), intent: "followup" }, "4x ROAS in 60 days", history);
    expect(brief.intent).toBe("strategy");
  });

  it("leaves a real follow-up question about the proposal alone", async () => {
    const q = "why is the bold option riskier?";
    const history = await historyDuringReply("conv_pick_q", q);
    expect(pickedOption(q)).toBe("bold"); // the word alone looks like a pick…
    const brief = normalizeBrief({ ...rulesBrief(q, history), intent: "chat" }, q, history);
    expect(brief.intent).toBe("chat"); // …but a question is answered, not taken as the pick.
  });

  it.each(["recommended", "go with recommended, our gross margin is about 40%"])(
    "builds the 12-section plan, not another proposal, when the operator picks: %s",
    async (reply) => {
      const history = await historyDuringReply(`conv_pick_plan_${reply.length}`, reply);
      const gathered = await gatherDiagnoseEvidence({ clientId: "client_trafficradius", request: reply, history, intent: "strategy" });
      expect(gathered.evidence).toContain("### Strategy framework (write the plan with these headings)");
      expect(gathered.evidence).not.toContain("(write the proposal with these headings)");
    },
    60_000,
  );

  it("loadLatestReports skips the empty row too", async () => {
    say("conv_pick_reports", "assistant", "# Meta Ads Comparison Report — Bethel\n\n## 12. Findings\n| CMP-001 | x | y |");
    say("conv_pick_reports", "user", "strategy");
    say("conv_pick_reports", "assistant", "");
    const reports = await loadLatestReports("conv_pick_reports");
    expect(reports).toHaveLength(1);
  });
});
