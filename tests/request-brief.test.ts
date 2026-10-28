import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentHistoryMessage } from "@/lib/agent/history";
import { parseBriefReply, resolvePeriod, rulesBrief } from "@/lib/agent/request-brief";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-28T10:00:00Z"));
});
afterEach(() => vi.useRealTimers());

const offered = (extra = ""): AgentHistoryMessage[] => [
  { role: "user", content: "optimize my budget" },
  {
    role: "assistant",
    content: `Budget optimisation for last 7 days. #1 Scale Leads ad set +20%. #2 Trim Brand ad set -20%. #3 Pause Retargeting ad set. ${extra} Nothing is queued in Approvals yet.`,
  },
];

describe("resolvePeriod", () => {
  it("uses a stated range and marks it explicit", () => {
    expect(resolvePeriod("optimize campaign X for 1 Oct to 15 Oct", [])).toMatchObject({
      since: "2026-10-01",
      until: "2026-10-15",
      explicit: true,
    });
  });

  it("defaults to the last 7 completed days", () => {
    expect(resolvePeriod("optimize my ads", [])).toEqual({
      since: "2026-10-21",
      until: "2026-10-27",
      label: "last 7 days",
      explicit: false,
    });
  });

  it("inherits the period an earlier user message set, not explicit", () => {
    const history: AgentHistoryMessage[] = [
      { role: "user", content: "audit the account for the last 30 days" },
      { role: "assistant", content: "Here is the audit." },
    ];
    expect(resolvePeriod("what should I optimise?", history)).toMatchObject({
      since: "2026-09-28",
      until: "2026-10-27",
      explicit: false,
    });
  });

  it("the newest stated period wins over an older one", () => {
    const history: AgentHistoryMessage[] = [
      { role: "user", content: "audit last 90 days" },
      { role: "assistant", content: "done" },
      { role: "user", content: "now last 14 days" },
      { role: "assistant", content: "done" },
    ];
    expect(resolvePeriod("what should I fix", history).since).toBe("2026-10-14");
  });
});

describe("rulesBrief", () => {
  it("treats a question as analyse, not act", () => {
    const brief = rulesBrief("how can I optimise my budget?", []);
    expect(brief.mode).toBe("analyse");
    expect(brief.focus).toEqual(["budget"]);
    expect(brief.optimizationAsk).toBe(true);
    expect(brief.queue.requested).toBe(false);
    expect(brief.source).toBe("rules");
  });

  it("queue by ref numbers", () => {
    const brief = rulesBrief("queue #2 and #3", offered());
    expect(brief.intent).toBe("optimize");
    expect(brief.mode).toBe("act");
    expect(brief.queue).toMatchObject({ requested: true, all: false, refs: [2, 3] });
  });

  it("expands a ref range", () => {
    expect(rulesBrief("queue #1-#3", offered()).queue.refs).toEqual([1, 2, 3]);
  });

  it("queue all", () => {
    const brief = rulesBrief("apply all of these", offered());
    expect(brief.mode).toBe("act");
    expect(brief.queue).toMatchObject({ requested: true, all: true, refs: [] });
  });

  it("queue by focus", () => {
    const brief = rulesBrief("queue the budget changes", offered());
    expect(brief.queue).toMatchObject({ requested: true, all: false, focus: ["budget"] });
  });

  it("a named entity in an instruction", () => {
    const brief = rulesBrief('pause the "Retargeting – AU" ad set', []);
    expect(brief.mode).toBe("act");
    expect(brief.scope.mentions).toEqual(["Retargeting – AU"]);
    expect(brief.queue.entities).toEqual(["Retargeting – AU"]);
  });

  it("a direct instruction names an area but never selects the proposals shown earlier", () => {
    const brief = rulesBrief('raise the budget of "Leads Brisbane" ad set to 60', offered());
    expect(brief.mode).toBe("act");
    expect(brief.focus).toEqual(["budget"]);
    expect(brief.queue.entities).toEqual(["Leads Brisbane"]);
    expect(brief.queue.focus).toEqual([]);
    expect(brief.queue.all).toBe(false);
  });

  it("an unquoted entity before the word ad set", () => {
    const brief = rulesBrief("pls pause the retargeting adset", []);
    expect(brief.mode).toBe("act");
    expect(brief.queue.entities).toEqual(["retargeting"]);
  });

  it("a negated entity is excluded, never queued", () => {
    const brief = rulesBrief("queue all of these but don't touch the Brand campaign", offered());
    expect(brief.queue.all).toBe(true);
    expect(brief.exclude).toEqual(["Brand"]);
    expect(brief.queue.entities).toEqual([]);
    expect(brief.scope.mentions).toEqual([]);
  });

  it("states a scope for an analysis question", () => {
    const brief = rulesBrief("optimize campaign Leads Brisbane for the last 14 days", []);
    expect(brief.scope.mentions).toEqual(["Leads Brisbane"]);
    expect(brief.mode).toBe("analyse");
    expect(brief.period).toMatchObject({ since: "2026-10-14", until: "2026-10-27", explicit: true });
  });

  it("is conservative: a vague message never becomes act", () => {
    for (const text of ["what if I paused the Brand ad set", "should I pause it?", "ok", "my budget is high"]) {
      expect(rulesBrief(text, offered()).mode, text).toBe("analyse");
    }
  });

  it("only optimisation intents can queue", () => {
    const brief = rulesBrief("send me the report", []);
    expect(brief.queue.requested).toBe(false);
    expect(brief.mode).toBe("analyse");
  });

  it("chat has no period", () => {
    expect(rulesBrief("thanks!", []).period).toBeNull();
  });
});

describe("parseBriefReply", () => {
  const valid = {
    intent: "optimize",
    mode: "analyse",
    focus: ["placements"],
    scope: [],
    periodStated: false,
    optimizationAsk: true,
    queue: { requested: false, all: false, refs: [], focus: [], entities: [] },
    exclude: [],
  };

  it("accepts valid JSON and computes the period in code", () => {
    const brief = parseBriefReply(`Sure: ${JSON.stringify(valid)}`, "improve my placements", []);
    expect(brief).toMatchObject({ intent: "optimize", mode: "analyse", focus: ["placements"], source: "model" });
    expect(brief!.period).toMatchObject({ since: "2026-10-21", until: "2026-10-27", explicit: false });
  });

  it("ignores a period the model invented", () => {
    const brief = parseBriefReply(
      JSON.stringify({ ...valid, period: { since: "1999-01-01", until: "1999-01-02" } }),
      "improve my placements",
      [],
    );
    expect(brief!.period!.since).toBe("2026-10-21");
  });

  it("rejects what it cannot trust", () => {
    expect(parseBriefReply("not json", "x", [])).toBeNull();
    expect(parseBriefReply(JSON.stringify({ ...valid, intent: "nonsense" }), "x", [])).toBeNull();
    expect(parseBriefReply(JSON.stringify({ ...valid, focus: ["vibes"] }), "x", [])).toBeNull();
    expect(
      parseBriefReply(JSON.stringify({ ...valid, queue: { ...valid.queue, refs: [0] } }), "x", []),
    ).toBeNull();
    expect(
      parseBriefReply(JSON.stringify({ ...valid, queue: { ...valid.queue, refs: [1.5] } }), "x", []),
    ).toBeNull();
  });

  it("act needs both the mode and the queue request", () => {
    const modeOnly = parseBriefReply(JSON.stringify({ ...valid, mode: "act" }), "x", []);
    expect(modeOnly!.mode).toBe("analyse");
    const queueOnly = parseBriefReply(
      JSON.stringify({ ...valid, queue: { ...valid.queue, requested: true } }),
      "x",
      [],
    );
    expect(queueOnly!.mode).toBe("analyse");
    expect(queueOnly!.queue.requested).toBe(false);
    const both = parseBriefReply(
      JSON.stringify({ ...valid, mode: "act", queue: { ...valid.queue, requested: true, refs: [2] } }),
      "queue #2",
      offered(),
    );
    expect(both!.mode).toBe("act");
    expect(both!.queue).toMatchObject({ requested: true, refs: [2] });
  });

  it("non-optimisation intents cannot queue", () => {
    const brief = parseBriefReply(
      JSON.stringify({
        ...valid,
        intent: "audit",
        mode: "act",
        queue: { requested: true, all: true, refs: [], focus: [], entities: ["X"] },
      }),
      "run an audit",
      [],
    );
    expect(brief!.mode).toBe("analyse");
    expect(brief!.queue).toEqual({ requested: false, all: false, refs: [], focus: [], entities: [] });
  });
});
