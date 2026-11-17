import { afterEach, describe, expect, it } from "vitest";
import type { AgentHistoryMessage } from "@/lib/agent/history";
import { normalizeBrief, parseBriefReply, rulesBrief } from "@/lib/agent/request-brief";
import { buildClassifierPrompt } from "@/lib/agent/intent-classifier";
import { runAgentTurn } from "@/lib/agent/run-turn";
import { cancelTask, createTask, getTask, runTask } from "@/lib/agent/task-runner";
import {
  createStopWatch,
  isStopCommand,
  looksLikeResume,
  resumedRequest,
  STOPPED_MARKER,
  stoppedReplyContent,
  stoppedTurn,
} from "@/lib/agent/turn-stop";
import { getDemoStore, resetDemoStore } from "@/lib/demo/store";
import type { Message, Task } from "@/types";

const u = (content: string): AgentHistoryMessage => ({ role: "user", content });
const a = (content: string): AgentHistoryMessage => ({ role: "assistant", content });
const STOPPED_PLAN = `# Bethel — strategy to 1.3 purchases a day\n\n## 1. Strategy header\n**Goal:** …\n\n## 2. Situation summary\nThe account is profitable and\n\n${STOPPED_MARKER}`;

describe("stop and resume helpers", () => {
  it("keeps what was written and ends it with the marker; a status line alone is not a reply", () => {
    expect(stoppedReplyContent("Part of the plan", false)).toBe(`Part of the plan\n\n${STOPPED_MARKER}`);
    expect(stoppedReplyContent("_Loading the account snapshot…_", true)).toBe(STOPPED_MARKER);
    expect(stoppedReplyContent("", false)).toBe(STOPPED_MARKER);
  });

  it("finds the stopped reply and what it was answering", () => {
    const history = [u("compare last 30 days"), a("# Comparison …"), u("strategy for each campaign"), a(STOPPED_PLAN)];
    expect(stoppedTurn(history)).toEqual({ request: "strategy for each campaign", historyBefore: history.slice(0, 2) });
    expect(stoppedTurn([u("hi"), a("Hello!")])).toBeNull();
  });

  it.each(["continue", "go on", "Resume please", "ok, keep going", "continue but only for the Basket campaign", "go on and make it shorter"])(
    "reads a resume: %s",
    (m) => expect(looksLikeResume(m)).toBe(true),
  );

  it.each(["give me the comparison instead", "how did last week go?", "stop"])("not a resume: %s", (m) => expect(looksLikeResume(m)).toBe(false));

  it.each(["stop", "Stop!", "wait", "pause", "hold on", "cancel that"])("a stop word only stops: %s", (m) => expect(isStopCommand(m)).toBe(true));

  it.each(["stop the Basket ad set", "wait, use the bold target", "continue"])("not a bare stop: %s", (m) => expect(isStopCommand(m)).toBe(false));

  it("resumes the original request, with the operator's change when there is one", () => {
    const stopped = { request: "strategy for each campaign", historyBefore: [] };
    expect(resumedRequest(stopped, "continue")).toBe("strategy for each campaign");
    expect(resumedRequest(stopped, "continue but make it shorter")).toContain('then said: "continue but make it shorter"');
    expect(resumedRequest(stopped, "continue but make it shorter")).toMatch(/^strategy for each campaign/);
  });

  it("the stop watch reads the task at most once per interval and stays stopped", async () => {
    let reads = 0;
    let status: Task["status"] = "running";
    const watch = createStopWatch("t", async () => {
      reads++;
      return { status } as Task;
    }, 1_000);
    expect(await watch.check()).toBe(false);
    status = "cancelled";
    expect(await watch.check()).toBe(false); // throttled: not read again yet
    expect(await watch.check(true)).toBe(true);
    expect(await watch.check()).toBe(true);
    expect(reads).toBe(2);
  });
});

describe("the workspace understands a resume", () => {
  const history = [u("compare last 30 days"), a("# Comparison …"), u("strategy for each campaign"), a(STOPPED_PLAN)];

  it("tells the classifier the last reply was stopped and what it was answering", () => {
    const prompt = buildClassifierPrompt("continue", history);
    expect(prompt).toContain("the operator stopped the assistant's last reply before it finished");
    expect(prompt).toContain('"strategy for each campaign"');
  });

  it("takes the model's reading", () => {
    const brief = normalizeBrief(parseBriefReply('{"intent":"strategy","resumesStopped":true}', "carry on but just the budget part", history)!, "carry on but just the budget part", history);
    expect(brief.resumesStopped).toBe(true);
  });

  it("the word patterns stand in without a model", () => {
    expect(rulesBrief("continue", history).resumesStopped).toBe(true);
    expect(rulesBrief("how did last week go?", history).resumesStopped).toBe(false);
  });

  it("is never a resume when the last reply finished", () => {
    const done = [u("strategy"), a("# Strategy — Bethel\n\nA finished reply.")];
    expect(rulesBrief("continue", done).resumesStopped).toBe(false);
    expect(parseBriefReply('{"intent":"strategy","resumesStopped":true}', "continue", done)!.resumesStopped).toBe(false);
  });
});

describe("a real turn (demo mode)", () => {
  afterEach(() => resetDemoStore());

  let clock = Date.parse("2026-11-17T10:00:00Z");
  function say(conversationId: string, role: Message["role"], content: string, metadata: Message["metadata"] = null): Message {
    const m = {
      id: `msg_${Math.random().toString(36).slice(2, 10)}`,
      conversation_id: conversationId,
      role,
      content,
      tool_call_id: null,
      metadata,
      created_at: new Date((clock += 1000)).toISOString(),
    } as Message;
    getDemoStore().messages.push(m);
    return m;
  }

  it("stops midway: keeps what was written, ends with the marker, and is marked stopped", async () => {
    const conv = "conv_stop_1";
    say(conv, "user", "Build me a strategy to 4x ROAS in 60 days");
    const placeholder = say(conv, "assistant", "", { streaming: true } as Message["metadata"]);
    const task = await createTask({ clientId: "client_trafficradius", createdBy: "profile_operator_demo", title: "strategy", goal: "Build me a strategy to 4x ROAS in 60 days", conversationId: conv });
    let stopped = false;
    const result = await runAgentTurn({
      taskId: task.id,
      assistantMessage: placeholder,
      useMetaDirect: false,
      stopCheckEveryMs: 0,
      // The operator presses Stop as soon as the first progress arrives.
      emit: () => {
        if (!stopped) {
          stopped = true;
          void cancelTask(task.id);
        }
      },
    });
    expect(result.message.metadata).toMatchObject({ status: "stopped", stopped: true, streaming: false });
    expect(result.message.content.endsWith(STOPPED_MARKER)).toBe(true);
    const saved = getDemoStore().messages.find((m) => m.id === placeholder.id)!;
    expect(saved.content.endsWith(STOPPED_MARKER)).toBe(true);
  }, 60_000);

  it("a finished reply is never marked stopped", async () => {
    const conv = "conv_stop_2";
    say(conv, "user", "hi");
    const placeholder = say(conv, "assistant", "", { streaming: true } as Message["metadata"]);
    const task = await createTask({ clientId: "client_trafficradius", createdBy: "profile_operator_demo", title: "hi", goal: "hi", conversationId: conv });
    const result = await runAgentTurn({ taskId: task.id, assistantMessage: placeholder, useMetaDirect: false, stopCheckEveryMs: 0 });
    expect(result.message.metadata?.stopped).toBeUndefined();
    expect(result.message.content).not.toContain(STOPPED_MARKER);
  }, 60_000);

  it("resumes with the operator's change: runs the original request plus the change", async () => {
    const conv = "conv_resume_1";
    say(conv, "user", "Build me a strategy to 4x ROAS in 60 days");
    say(conv, "assistant", `# Strategy — Traffic Radius\n\n## 1. Strategy header\nPart of it\n\n${STOPPED_MARKER}`, { status: "stopped", stopped: true } as Message["metadata"]);
    say(conv, "user", "continue but for each campaign");
    const task = await createTask({ clientId: "client_trafficradius", createdBy: "profile_operator_demo", title: "continue", goal: "continue but for each campaign", conversationId: conv });
    await runTask(task.id);
    const after = await getTask(task.id);
    expect(after.goal).toMatch(/^Build me a strategy to 4x ROAS in 60 days/);
    expect(after.goal).toContain("continue but for each campaign");
  }, 60_000);
});
