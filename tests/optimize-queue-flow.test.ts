import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { createTask, getTask, runTask } from "@/lib/agent/task-runner";
import type { Message } from "@/types";

/**
 * Whole turns in demo mode: a stubbed classifier (the operator's meaning as JSON) and a stubbed
 * writer. What is under test is the pipeline around them: what gets numbered, what gets queued.
 */
const generateText = vi.fn();
const streamText = vi.fn();
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateText: (...args: unknown[]) => generateText(...args),
  streamText: (...args: unknown[]) => streamText(...args),
}));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: () => () => ({ provider: "stub" }) }));

const CLIENT = "client_modern_dental";
const OPERATOR = "profile_operator_demo";

const briefJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    intent: "optimize",
    mode: "analyse",
    focus: [],
    scope: [],
    periodStated: false,
    optimizationAsk: true,
    queue: { requested: false, all: false, refs: [], focus: [], entities: [] },
    exclude: [],
    ...over,
  });

let writerText = "Here is what I found.";
let writerCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  resetConfigCache();
  writerText = "Here is what I found.";
  writerCalls = [];
  generateText.mockReset();
  streamText.mockImplementation(() => ({
    fullStream: (async function* () {
      yield { type: "start-step" };
      const json = writerCalls.map((c) => `\n\`\`\`json\n${JSON.stringify({ tool: c.name, args: c.args })}\n\`\`\``).join("");
      yield { type: "text-delta", text: writerText + json };
    })(),
  }));
});

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  resetConfigCache();
});

let conversationId = "";
function newConversation() {
  const store = getDemoStore();
  conversationId = `conv_flow_${Math.random().toString(36).slice(2, 8)}`;
  store.conversations.push({
    id: conversationId,
    client_id: CLIENT,
    task_id: null,
    created_by: OPERATOR,
    title: "flow",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

let clock = Date.parse("2026-10-28T09:00:00Z");
const tick = () => new Date((clock += 1000)).toISOString();

function say(role: "user" | "assistant", content: string) {
  const message: Message = {
    id: `msg_${Math.random().toString(36).slice(2, 10)}`,
    conversation_id: conversationId,
    role,
    content,
    tool_call_id: null,
    metadata: null,
    created_at: tick(),
  };
  getDemoStore().messages.push(message);
}

/** One operator message in, the finished task out (the reply is recorded for the next turn's history). */
async function turn(message: string, brief: Record<string, unknown>) {
  generateText.mockResolvedValueOnce({ text: briefJson(brief) });
  say("user", message);
  const task = await createTask({ clientId: CLIENT, createdBy: OPERATOR, title: message, goal: message, conversationId });
  getDemoStore().tasks.find((t) => t.id === task.id)!.created_at = tick();
  await runTask(task.id);
  const done = await getTask(task.id);
  const summary = String(done.agent_state?.summary ?? "");
  say("assistant", summary);
  return { task: done, summary };
}

const approvals = () => getDemoStore().approvals.filter((a) => a.client_id === CLIENT);
const offerOf = (task: { agent_state: Record<string, unknown> | null }) =>
  (task.agent_state?.optimize_offer as { items: Array<{ ref: number; tool: string; focus: string; args: Record<string, unknown> }> }).items;

describe("optimise, then queue", () => {
  beforeEach(() => newConversation());

  it("an optimisation ask shows numbered proposals and queues nothing", async () => {
    const before = approvals().length;
    const { task, summary } = await turn("optimize my budget", { focus: ["budget"] });
    expect(approvals().length).toBe(before);
    expect(offerOf(task).length).toBeGreaterThan(0);
    expect(summary).toMatch(/Who does what/);
    expect(summary).toMatch(/#1/);
    expect(summary).not.toMatch(/Queued in Approvals \([1-9]/);
    expect(task.status).toBe("done");
  });

  it("'queue #1' queues exactly proposal #1 and says so", async () => {
    const { task: first } = await turn("optimize my budget", { focus: ["budget"] });
    const proposal = offerOf(first).find((o) => o.ref === 1)!;
    const before = approvals().length;
    const { task, summary } = await turn("queue #1", {
      mode: "act",
      optimizationAsk: false,
      queue: { requested: true, all: false, refs: [1], focus: [], entities: [] },
    });
    const created = approvals().slice(before);
    expect(created).toHaveLength(1);
    expect(created[0]!.tool_name).toBe(proposal.tool);
    expect(created[0]!.proposed_args).toMatchObject(
      Object.fromEntries(Object.entries(proposal.args).filter(([k]) => !k.startsWith("_") && k !== "previous_daily_budget_cents")),
    );
    expect(summary).toContain("### Queued in Approvals (1)");
    expect(summary).toMatch(/#1/);
    expect(task.status).toBe("waiting_approval");
    // The list keeps its numbers for the next "queue #n".
    expect(offerOf(task).map((o) => o.ref)).toEqual(offerOf(first).map((o) => o.ref));
  });

  it("'queue the budget changes' never queues a reactivation or a new ad set", async () => {
    const { task: first } = await turn("what should i do about reactivation, structure and budget", {
      focus: ["budget", "reactivation", "structure"],
    });
    expect(offerOf(first).some((o) => o.focus === "reactivation")).toBe(true);
    expect(offerOf(first).some((o) => o.focus === "structure")).toBe(true);
    const before = approvals().length;
    await turn("queue the budget changes", {
      mode: "act",
      optimizationAsk: false,
      focus: ["budget"],
      queue: { requested: true, all: false, refs: [], focus: ["budget"], entities: [] },
    });
    const tools = approvals().slice(before).map((a) => a.tool_name);
    expect(tools.length).toBeGreaterThan(0);
    expect(tools).not.toContain("resume_campaign");
    expect(tools).not.toContain("create_adset");
    expect(tools.every((t) => t === "update_adset_budget" || t === "update_campaign_budget" || t === "pause_adset")).toBe(true);
  });

  it("sending the same queue message twice does not duplicate the approval", async () => {
    await turn("optimize my budget", { focus: ["budget"] });
    const q = { mode: "act", optimizationAsk: false, queue: { requested: true, all: false, refs: [1], focus: [], entities: [] } };
    const before = approvals().length;
    await turn("queue #1", q);
    const afterFirst = approvals().length;
    expect(afterFirst).toBe(before + 1);
    const { summary, task } = await turn("queue #1", q);
    expect(approvals().length).toBe(afterFirst);
    // The reply says it is already waiting, not that it was queued again.
    expect(summary).toContain("### Already in Approvals (1)");
    expect(summary).not.toMatch(/Queued in Approvals \([1-9]/);
    expect(task.status).toBe("done");
  });

  it("'apply all of these' queues everything that was shown and still applies", async () => {
    const { task: first } = await turn("optimize my budget and creative", { focus: ["budget", "creative"] });
    const shown = offerOf(first).length;
    const before = approvals().length;
    const { summary } = await turn("apply all of these", {
      mode: "act",
      optimizationAsk: false,
      queue: { requested: true, all: true, refs: [], focus: [], entities: [] },
    });
    expect(approvals().length - before).toBe(shown);
    expect(summary).toContain(`### Queued in Approvals (${shown})`);
  });

  it("'queue these' with nothing shown before queues nothing and says why", async () => {
    const before = approvals().length;
    const { summary } = await turn("queue all of these", {
      mode: "act",
      optimizationAsk: false,
      queue: { requested: true, all: true, refs: [], focus: [], entities: [] },
    });
    expect(approvals().length).toBe(before);
    expect(summary).toContain("### Queued in Approvals (0)");
    expect(summary).toMatch(/no earlier list/i);
  });

  it("a writer that claims it queued something it didn't is corrected by the block", async () => {
    writerText = "I've queued #1 in Approvals. Approve it to apply.";
    const before = approvals().length;
    const { summary } = await turn("optimize my budget", { focus: ["budget"] });
    expect(approvals().length).toBe(before);
    expect(summary).not.toMatch(/I've queued/);
    expect(summary).toContain("Approve it to apply.");
  });
});

describe("the writer can't queue what wasn't asked for", () => {
  beforeEach(() => newConversation());

  it("changes the writer proposes on an analysis turn are dropped", async () => {
    writerCalls = [{ name: "pause_adset", args: { account_id: "act_100200300", adset_id: "adset_mdc_npl_2" } }];
    const before = approvals().length;
    const { summary } = await turn("how is my budget doing", { intent: "optimize", focus: ["budget"] });
    expect(approvals().length).toBe(before);
    expect(summary).toMatch(/Not queued/);
    expect(summary).toMatch(/only queued when you ask/);
  });

  it("a direct instruction naming an ad set queues that change and only that", async () => {
    writerCalls = [
      { name: "pause_adset", args: { account_id: "act_100200300", adset_id: "adset_mdc_npl_2" } },
      { name: "pause_adset", args: { account_id: "act_100200300", adset_id: "adset_mdc_cosmetic_1" } },
    ];
    const before = approvals().length;
    const { summary } = await turn('pause the "New Patient Leads — Zip Radius" ad set', {
      mode: "act",
      optimizationAsk: false,
      scope: ["New Patient Leads — Zip Radius"],
      queue: { requested: true, all: false, refs: [], focus: [], entities: ["New Patient Leads — Zip Radius"] },
    });
    const created = approvals().slice(before);
    expect(created).toHaveLength(1);
    expect(created[0]!.tool_name).toBe("pause_adset");
    expect(created[0]!.proposed_args).toMatchObject({ adset_id: "adset_mdc_npl_2" });
    expect(summary).toContain("### Queued in Approvals (1)");
    expect(summary).toMatch(/Not queued \(1\)/);
  });

  it("a name that matches nothing queues nothing and says so", async () => {
    writerCalls = [{ name: "pause_adset", args: { account_id: "act_100200300", adset_id: "adset_mdc_npl_2" } }];
    const before = approvals().length;
    const { summary } = await turn('pause the "Nonexistent Set" ad set', {
      mode: "act",
      optimizationAsk: false,
      scope: ["Nonexistent Set"],
      queue: { requested: true, all: false, refs: [], focus: [], entities: ["Nonexistent Set"] },
    });
    expect(approvals().length).toBe(before);
    expect(summary).toMatch(/Nonexistent Set/);
    expect(summary).toMatch(/wasn.t found/);
  });
});
