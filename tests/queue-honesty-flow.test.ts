import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { createTask, getTask, runTask } from "@/lib/agent/task-runner";
import { renderQueueBlock, stripQueuedClaims } from "@/lib/agent/queue-selection";
import type { Message } from "@/types";

/**
 * Whole turns in demo mode, pinning what an operator is told and what reaches Approvals when a
 * turn goes sideways: a stale list, a refusal, a reply that over- or under-claims.
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
const ACCOUNT = "act_100200300";

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
  conversationId = `conv_honest_${Math.random().toString(36).slice(2, 8)}`;
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
const queueRefs = (refs: number[]) => ({
  mode: "act",
  optimizationAsk: false,
  queue: { requested: true, all: false, refs, focus: [], entities: [] },
});
const NPL = "New Patient Leads — Zip Radius";
const COSMETIC = "Cosmetic — Advantage+ Audience";

describe("a number means the list the operator last saw", () => {
  beforeEach(() => newConversation());

  it("after an audit, 'queue #1' does not reach back to an older optimisation list", async () => {
    await turn("optimize my budget", { focus: ["budget"] });
    await turn("audit my account", { intent: "audit", optimizationAsk: false });
    const before = approvals().length;
    const { summary } = await turn("queue #1", queueRefs([1]));
    expect(approvals().length).toBe(before);
    expect(summary).toMatch(/no earlier list/i);
  });

  it("a follow-up question about the list leaves the list in place", async () => {
    await turn("optimize my budget", { focus: ["budget"] });
    await turn("why is #1 suggested?", { intent: "followup", optimizationAsk: false });
    const before = approvals().length;
    await turn("queue #1", queueRefs([1]));
    expect(approvals().length).toBe(before + 1);
  });
});

describe("what the operator is told matches what was queued", () => {
  beforeEach(() => newConversation());

  it("a reply never says both were queued when Approvals refused one", async () => {
    writerText = "I've queued both changes in Approvals. Approve them to apply.";
    writerCalls = [
      { name: "pause_adset", args: { account_id: ACCOUNT, adset_id: "adset_mdc_npl_2" } },
      { name: "update_adset_budget", args: { account_id: ACCOUNT, adset_id: "adset_mdc_cosmetic_1", daily_budget_cents: -500 } },
    ];
    const before = approvals().length;
    const { summary } = await turn(`pause the "${NPL}" ad set and raise the budget of the "${COSMETIC}" ad set`, {
      mode: "act",
      optimizationAsk: false,
      scope: [NPL, COSMETIC],
      queue: { requested: true, all: false, refs: [], focus: [], entities: [NPL, COSMETIC] },
    });
    expect(approvals().length - before).toBe(1);
    expect(summary).not.toMatch(/queued both/i);
    expect(summary).toContain("### Queued in Approvals (1)");
    expect(summary).toMatch(/Not queued \(1\)/);
    expect(summary).toMatch(/Approvals refused/);
  });

  it("a refusal in a create flow is shown to the operator", async () => {
    writerText = "I've queued the ad in Approvals.";
    writerCalls = [{ name: "create_ad", args: { account_id: "act_not_granted_999", adset_id: "adset_mdc_npl_2", name: "New ad" } }];
    const before = approvals().length;
    const { summary } = await turn("write me an ad for the zip radius ad set", { intent: "ad_copy", optimizationAsk: false });
    expect(approvals().length).toBe(before);
    expect(summary).toMatch(/refused before reaching Approvals|Could not queue/i);
  });

  it("a create flow cannot be used to pause or change something else", async () => {
    writerText = "Here is the copy.";
    writerCalls = [{ name: "pause_adset", args: { account_id: ACCOUNT, adset_id: "adset_mdc_npl_2" } }];
    const before = approvals().length;
    const { summary } = await turn("write me an ad for the zip radius ad set", { intent: "ad_copy", optimizationAsk: false });
    expect(approvals().length).toBe(before);
    expect(summary).toMatch(/Not queued/);
  });

  it("a reply that is not about optimising is left as written", async () => {
    writerText = "Two budget changes are waiting in Approvals for your review.";
    const { summary } = await turn("what is waiting in approvals?", { intent: "general", optimizationAsk: false });
    expect(summary).toContain("Two budget changes are waiting in Approvals for your review.");
    writerText = "The ad set queued for review last week was approved.";
    const chat = await turn("did the ad set get approved?", { intent: "chat", optimizationAsk: false });
    expect(chat.summary).toContain("queued for review last week");
  });

  it("repeating a queue message for a change that was already approved says so, not 'still waiting'", async () => {
    await turn("optimize my budget", { focus: ["budget"] });
    await turn("queue #1", queueRefs([1]));
    const approval = approvals().at(-1)!;
    approval.status = "approved";
    const { summary } = await turn("queue #1", queueRefs([1]));
    expect(summary).toContain("### Already in Approvals (1)");
    expect(summary).toMatch(/already approved/i);
    expect(summary).not.toMatch(/still waiting for review/);
  });
});

describe("a queue turn does not re-show a list with different numbers", () => {
  beforeEach(() => newConversation());

  it("'queue #1' answers with the queue block, not a freshly numbered table", async () => {
    await turn("optimize my budget", { focus: ["budget"] });
    const { summary } = await turn("queue #1", queueRefs([1]));
    expect(summary).toContain("### Queued in Approvals (1)");
    expect(summary).not.toMatch(/Who does what/);
    expect(summary).not.toMatch(/Numbered proposals/);
  });
});

describe("stripQueuedClaims keeps true statements about the past", () => {
  it.each([
    "You queued #1 and #2 yesterday; both were approved and applied.",
    "- Paused the Brand ad set (queued in Approvals on 12 Oct, executed 13 Oct)",
    "Meta queued your ads for review.",
    "The earlier change you queued last week was rejected.",
  ])("%s", (text) => {
    expect(stripQueuedClaims(text)).toBe(text);
  });

  it("still removes a claim about this turn", () => {
    expect(stripQueuedClaims("I've queued #1 and #2 in Approvals.")).toBe("");
  });
});

describe("renderQueueBlock says where an earlier approval really stands", () => {
  const block = (status: string) => renderQueueBlock({ queued: [], alreadyQueued: [{ label: "#1 Scale ad set A", status }], notQueued: [] });

  it("pending: still waiting", () => expect(block("pending")).toMatch(/still waiting for review/));
  it("edited: waiting, and edited", () => expect(block("edited")).toMatch(/edited/));
  it("approved: already approved", () => {
    expect(block("approved")).toMatch(/already approved/i);
    expect(block("approved")).not.toMatch(/still waiting for review/);
  });
  it("executing: being applied", () => expect(block("executing")).toMatch(/being applied/i));
  it("a plain label is still accepted and means pending", () => {
    expect(renderQueueBlock({ queued: [], alreadyQueued: ["#1 Scale ad set A"], notQueued: [] })).toMatch(/still waiting for review/);
  });
});
