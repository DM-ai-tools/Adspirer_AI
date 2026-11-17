import { afterEach, describe, expect, it } from "vitest";
import { gatherDiagnoseEvidence } from "@/lib/agent/adspirer-agent";
import { pickedOption } from "@/lib/agent/account-strategy-brief";
import type { AgentHistoryMessage } from "@/lib/agent/history";
import { normalizeBrief, rulesBrief } from "@/lib/agent/request-brief";
import { insertTargetsTable, loadStrategyOffer, saveStrategyOffer, TARGETS_TABLE_MARKER, type StrategyOfferRecord } from "@/lib/agent/strategy-offer";
import { strategyState } from "@/lib/agent/strategy-state";
import { createTask, getTask, runTask } from "@/lib/agent/task-runner";
import { getDemoStore, resetDemoStore } from "@/lib/demo/store";
import type { TargetOption } from "@/lib/strategy/account-strategy";
import type { Message } from "@/types";

/**
 * Black Tie Classic, 17 Nov 2026: the operator confirmed "bold" three times and got the target offer back
 * each time. The offer was tracked by reading chat text (its "pick a target" line was cut off when the
 * history shortened older replies) and the options were recalculated each turn (once there were none).
 * The offer is now stored on the task and the pick uses the figures the operator saw.
 */

const u = (content: string): AgentHistoryMessage => ({ role: "user", content });
const a = (content: string): AgentHistoryMessage => ({ role: "assistant", content });

const OPTIONS: TargetOption[] = [
  { key: "safe", mode: "efficiency", costPerCents: 1_151, roas: null, windowDays: 30, basis: "x" },
  { key: "recommended", mode: "efficiency", costPerCents: 1_147, roas: null, windowDays: 45, basis: "y" },
  { key: "bold", mode: "efficiency", costPerCents: 1_023, roas: null, windowDays: 60, basis: "z" },
];
const OPEN: StrategyOfferRecord = { status: "open", createdAt: "2026-11-17T14:44:00Z", kind: "leads", options: OPTIONS };

describe("asking for options is not picking one", () => {
  it.each([
    "i dont want the comparison report, i want the new safe recommended and bold options for improvement that i can aim for",
    "show me safe and bold again",
    "what's the difference between recommended and bold?",
  ])("no pick: %s", (m) => expect(pickedOption(m)).toBeNull());

  it.each([
    ["lets go with bold, give me the strategy report", "bold"],
    ["go with Bold, 11 became qualified clients", "bold"],
    ["recommended", "recommended"],
  ])("pick: %s", (m, key) => expect(pickedOption(m)).toBe(key));
});

describe("the stored offer decides, whatever the chat text says", () => {
  // The offer's text was cut short in the history and an off-track reply came after it.
  const history = [u("give me a strategy"), a("# Comparison Report — Black Tie Classic\n…[earlier report truncated]"), u("options?"), a("Here are three options…")];

  it("an open stored offer is open even when the text shows no offer", () => {
    expect(strategyState(history).open).toBe(false);
    expect(strategyState(history, null, OPEN).open).toBe(true);
    expect(strategyState(history, null, OPEN).options[2]).toBe("Bold — cost per lead 10.23, by 60 days");
  });

  it("a closed stored offer is closed even when the text looks like an offer", () => {
    const looksOpen = [u("strategy"), a("# Strategy — X\n\n---\n**Next:** reply **safe**, **recommended** or **bold** to pick a target for the strategy.")];
    expect(strategyState(looksOpen).open).toBe(true);
    expect(strategyState(looksOpen, null, { status: "closed", createdAt: "" }).open).toBe(false);
  });

  it("routes 'lets go with bold' to the strategy with the pick, from the stored offer", () => {
    const state = strategyState(history, null, OPEN);
    const req = "lets go with bold, give me the strategy report";
    const brief = normalizeBrief(rulesBrief(req, history, state), req, history, state);
    expect(brief).toMatchObject({ intent: "strategy", strategyPick: "bold" });
  });
});

describe("the targets table is the computed one", () => {
  const table = "| Option | Cost per lead |\n|---|---|\n| bold | $10.23 |";

  it("goes where the writer put the marker", () => {
    expect(insertTargetsTable(`**Targets I'd set**\n\n${TARGETS_TABLE_MARKER}\n\nI recommend bold.`, table)).toBe(`**Targets I'd set**\n\n${table}\n\nI recommend bold.`);
  });

  it("goes under the heading when the writer left the marker out", () => {
    const out = insertTargetsTable("# Strategy — X\n\n**Targets I'd set** — here they are.\n\nI recommend bold.", table);
    expect(out).toContain(`**Targets I'd set** — here they are.\n\n${table}`);
  });

  it("is added at the end when the writer wrote something else entirely (e.g. a comparison)", () => {
    expect(insertTargetsTable("# Comparison Report — X\n\nnumbers…", table)).toMatch(/\*\*Targets I'd set\*\*\n\n\| Option/);
  });
});

describe("a real chat (demo mode)", () => {
  afterEach(() => resetDemoStore());

  let clock = Date.parse("2026-11-17T14:40:00Z");
  function say(conversationId: string, role: Message["role"], content: string) {
    getDemoStore().messages.push({
      id: `msg_${Math.random().toString(36).slice(2, 10)}`,
      conversation_id: conversationId,
      role,
      content,
      tool_call_id: null,
      metadata: null,
      created_at: new Date((clock += 1000)).toISOString(),
    } as Message);
  }
  async function turn(conv: string, text: string) {
    say(conv, "user", text);
    const task = await createTask({ clientId: "client_modern_dental", createdBy: "profile_operator_demo", title: text, goal: text, conversationId: conv });
    const done = await runTask(task.id);
    const reply = typeof done.agent_state?.summary === "string" ? done.agent_state.summary : "";
    say(conv, "assistant", reply);
    return { task: await getTask(task.id), reply };
  }

  it("stores the offer, then a pick after an off-track turn builds the plan and closes it", async () => {
    const conv = "conv_offer_1";
    const first = await turn(conv, "give me a strategy report");
    expect((first.task.agent_state as Record<string, unknown>).strategy_offer).toMatchObject({ status: "open", kind: "leads" });
    // An off-track turn in between (it records nothing about the offer).
    await turn(conv, "thanks, how are leads trending this week?");
    expect(await loadStrategyOffer(conv)).toMatchObject({ status: "open" });

    const pick = await turn(conv, "lets go with bold, give me the strategy report");
    expect(pick.task.agent_state?.strategy_offer).toMatchObject({ status: "closed" });
    expect(await loadStrategyOffer(conv)).toMatchObject({ status: "closed" });
  }, 120_000);

  it("replays the Black Tie Classic messages: every pick builds a plan, every options ask makes a fresh offer", async () => {
    const conv = "conv_blacktie";
    const offerAfter = async (text: string) => {
      const t = await turn(conv, text);
      const status = (t.task.agent_state?.strategy_offer as { status?: string } | undefined)?.status;
      if (!status) console.log("DBG no offer for", text, "→", t.task.status, t.reply.slice(0, 300));
      return status;
    };
    expect(await offerAfter("okay so give me the strategy report")).toBe("open");
    expect(await offerAfter("lets go with recommended, Lead quality: We don’t currently have confirmed figures. Treat this as unknown.")).toBe("closed");
    expect(await offerAfter("okay so based on the comparison report what would you suggest are the new safe recommended and bold improvement options that i can aim for")).toBe("open");
    expect(await offerAfter("i dont want the comparison report, i want the new safe recommended and bold options for improvement that i can aim for")).toBe("open");
    expect(await offerAfter("lets go with bold, give me the strategy report")).toBe("closed");
  }, 240_000);

  it("uses the stored option's figures even when today's calculation differs", async () => {
    const history = [u("give me a strategy report"), a("# Strategy — Modern Dental\n\n---\n**Next:** reply **safe**, **recommended** or **bold** to pick a target for the strategy.")];
    const stored: StrategyOfferRecord = { ...OPEN, options: OPTIONS.map((o) => (o.key === "bold" ? { ...o, costPerCents: 1_234 } : o)) };
    const req = "lets go with bold";
    const brief = normalizeBrief(rulesBrief(req, history), req, history);
    const g = await gatherDiagnoseEvidence({ clientId: "client_modern_dental", request: req, history, intent: "strategy", brief, strategyOffer: stored });
    expect(g.evidence).toContain("### Strategy framework (write the plan with these headings)");
    expect(g.evidence).toContain("$12.34");
    expect(g.strategyOfferUpdate).toEqual({ status: "closed" });
  }, 60_000);

  it("a fresh proposal stores its options and hands the runner the table to insert", async () => {
    const g = await gatherDiagnoseEvidence({ clientId: "client_modern_dental", request: "give me a strategy report", history: [], intent: "strategy" });
    expect(g.strategyOfferUpdate).toMatchObject({ status: "open", kind: "leads" });
    expect(g.strategyTargetsTable).toBeTruthy();
    expect(g.evidence).toContain("[[TARGETS_TABLE]]");
  }, 60_000);
});

it("saveStrategyOffer stamps the record on the task", () => {
  const task = { agent_state: {} } as Parameters<typeof saveStrategyOffer>[0];
  saveStrategyOffer(task, { status: "open", kind: "sales", options: OPTIONS });
  expect((task.agent_state as Record<string, unknown>).strategy_offer).toMatchObject({ status: "open", kind: "sales" });
});
