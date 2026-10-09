import { describe, expect, it } from "vitest";
import {
  detectRequestIntent,
  detectRequestIntentWithHistory,
  isConversationalTurn,
  planTaskSteps,
  replyAwaitsOperator,
} from "@/lib/agent/task-plan";
import { createDeltaEncoder } from "@/lib/agent/run-turn";
import { truncatePastReply } from "@/lib/agent/history";
import {
  STALE_TASK_MESSAGE,
  isTaskStale,
  toPublicTask,
} from "@/lib/agent/task-public";
import { settleApprovalTaskState } from "@/lib/workflow/bindings";
import { cleanChatTitle } from "@/lib/agent/title";
import {
  extractMentionedNames,
  isStarterPrompt,
  shortDateLabel,
} from "@/lib/agent/title-service";
import type { Task } from "@/types";

describe("conversational fast path", () => {
  it.each([
    "hi",
    "Hey there!",
    "thanks",
    "great, thanks!",
    "got it",
    "What does CPM mean?",
    "what is ROAS",
    "explain frequency",
    "why is that?",
    "What's the difference between CPC and CPM?",
  ])("treats %j as chat", (text) => {
    expect(detectRequestIntent(text)).toBe("chat");
  });

  it.each([
    "yes",
    "ok go ahead",
    "what is my CPA last 7 days?",
    "what's the landing page URL?",
    "what are my campaigns",
    "explain why our spend dropped yesterday",
    "what does the budget look like on act_123",
  ])("does not treat %j as chat", (text) => {
    expect(isConversationalTurn(text)).toBe(false);
  });

  it("plans a short checklist without research for chat", () => {
    const ids = planTaskSteps("what does CPM mean?").map((s) => s.id);
    expect(ids).toEqual(["queued", "write_report", "complete"]);
  });
});

describe("narrow audit / ad copy triggers", () => {
  it("keeps explicit audit asks on the audit path", () => {
    expect(detectRequestIntent("Audit the account and summarize spend, delivery, and risks")).toBe("audit");
    expect(detectRequestIntent("run a health check on this account")).toBe("audit");
    expect(detectRequestIntent("diagnose why delivery dropped")).toBe("audit");
    expect(detectRequestIntent("full review of the account please")).toBe("audit");
  });

  it("routes plain performance questions to the lighter (non-audit) path", () => {
    const light = ["general", "list_campaigns"];
    expect(detectRequestIntent("how is spend pacing this week?")).toBe("general");
    expect(light).toContain(detectRequestIntent("which campaigns perform best?"));
    expect(detectRequestIntent("why is delivery low on the retargeting campaign")).toBe("general");
    expect(light).toContain(
      detectRequestIntent(
        "Which campaigns or ads are spending without results in the last 14 days, and what should we change?",
      ),
    );
  });

  it("does not start copy generation on a bare headline / CTA mention", () => {
    expect(detectRequestIntent("what's the CTA on the spring sale ad?")).not.toBe("ad_copy");
    expect(detectRequestIntent("is the headline too long on ad 1203")).not.toBe("ad_copy");
    expect(detectRequestIntent("write 3 headlines for the spring sale")).toBe("ad_copy");
    expect(detectRequestIntent("generate ad copy for our dental offer")).toBe("ad_copy");
  });

  it("does not re-run a delivered audit on a follow-up question", () => {
    const longAudit = `## Meta Ads audit\n${"Spend details and findings. ".repeat(120)}`;
    expect(
      detectRequestIntentWithHistory("which campaigns are wasting spend?", [
        { role: "user", content: "Audit the account last 30 days" },
        { role: "assistant", content: longAudit },
      ]),
    ).not.toBe("audit");
  });
});

describe("replyAwaitsOperator", () => {
  it("ignores question marks in URLs and code", () => {
    expect(
      replyAwaitsOperator(
        "Your ad points to https://x.test/lp?utm_source=meta&utm_medium=paid.\n\nSpend is on track.",
      ),
    ).toBe(false);
    expect(replyAwaitsOperator("Run `select ?` later.\n\nAll done.")).toBe(false);
  });

  it("ignores an earlier rhetorical question", () => {
    expect(
      replyAwaitsOperator("Why is CPA up? Mostly frequency.\n\nCPA rose 18% to £42."),
    ).toBe(false);
  });

  it("detects a closing question", () => {
    expect(replyAwaitsOperator("CPA rose to £42.\n\nWant me to pull ad-level data?")).toBe(true);
    expect(
      replyAwaitsOperator("I need a few details:\n1. Daily budget?\n2. Landing page URL?"),
    ).toBe(true);
  });
});

describe("delta encoder", () => {
  it("sends only appended text with the running total", () => {
    const encode = createDeltaEncoder();
    expect(encode("Hel", { phase: "write_report" })).toEqual({
      content: "Hel",
      total: 3,
      phase: "write_report",
    });
    expect(encode("Hello")).toEqual({ append: "lo", total: 5 });
    expect(encode("Hello")).toEqual({ append: "", total: 5 });
  });

  it("resets with full content when text is rewritten", () => {
    const encode = createDeltaEncoder();
    encode("_Fetching account overview…_");
    expect(encode("CPM is the cost per 1,000 impressions.")).toEqual({
      content: "CPM is the cost per 1,000 impressions.",
      total: 38,
    });
  });
});

describe("history truncation", () => {
  it("cuts long replies and marks them", () => {
    const long = Array.from({ length: 200 }, (_, i) => `Line ${i} of the audit.`).join("\n");
    const cut = truncatePastReply(long, 1500);
    expect(cut.length).toBeLessThan(1600);
    expect(cut.endsWith("[earlier report truncated]")).toBe(true);
    expect(truncatePastReply("short", 1500)).toBe("short");
  });
});

describe("task payload hygiene", () => {
  const base: Task = {
    id: "task_1",
    client_id: "c1",
    conversation_id: "conv_1",
    created_by: "u1",
    title: "t",
    goal: "g",
    status: "running",
    agent_state: { summary: "hi", messages: [{ role: "assistant", content: "hi" }] },
    error_message: null,
    paused_at: null,
    completed_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  it("strips the model transcript", () => {
    const pub = toPublicTask(base);
    expect(pub.agent_state).toEqual({ summary: "hi" });
    expect(base.agent_state?.messages).toBeDefined();
  });

  it("flags running tasks silent for over 6 minutes", () => {
    expect(isTaskStale(base)).toBe(false);
    const old = new Date(Date.now() - 7 * 60 * 1000).toISOString();
    expect(isTaskStale({ ...base, updated_at: old })).toBe(true);
    expect(isTaskStale({ ...base, status: "done", updated_at: old })).toBe(false);
    expect(STALE_TASK_MESSAGE).toMatch(/send your message again/);
  });

  it("settles approval tasks with an honest label and no waiting step", () => {
    const steps = [
      { id: "write_report", label: "Draft", state: "done" },
      { id: "approval", label: "Queue Approvals", state: "waiting" },
      { id: "complete", label: "Complete", state: "pending" },
    ];
    const rejected = settleApprovalTaskState({ steps }, [
      { status: "rejected" },
      { status: "cancelled" },
    ]);
    expect(rejected.statusLabel).toBe("Changes rejected");
    expect(
      (rejected.steps as Array<{ id: string; state: string }>).every(
        (s) => s.state === "done",
      ),
    ).toBe(true);
    expect(settleApprovalTaskState({}, [{ status: "executed" }]).statusLabel).toBe(
      "Changes applied",
    );
    expect(
      settleApprovalTaskState({}, [{ status: "executed" }, { status: "rejected" }])
        .statusLabel,
    ).toBe("Approvals resolved");
  });
});

describe("chat titles", () => {
  it("removes generic filler words", () => {
    expect(cleanChatTitle('"Recent Campaign Audit Request"')).toBe("Campaign Audit");
    expect(cleanChatTitle("Echelonn creative audit.")).toBe("Echelonn creative audit");
  });

  it("recognises starter prompts and quoted names", () => {
    expect(isStarterPrompt("Optimize ads in this account")).toBe(true);
    expect(isStarterPrompt("Optimize the TR Lead Gen ads")).toBe(false);
    expect(extractMentionedNames('Pause "TR Lead Gen – UK" today')).toEqual([
      "TR Lead Gen – UK",
    ]);
    expect(shortDateLabel("2026-10-09T10:00:00Z")).toBe("9 Oct");
  });
});
