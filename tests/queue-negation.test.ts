import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentHistoryMessage } from "@/lib/agent/history";
import { normalizeBrief, parseBriefReply, rulesBrief } from "@/lib/agent/request-brief";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-28T10:00:00Z"));
});
afterEach(() => vi.useRealTimers());

const shown: AgentHistoryMessage[] = [
  { role: "user", content: "optimize my budget" },
  { role: "assistant", content: "### Numbered proposals\n- #1 Scale A\n- #2 Trim B\n- #3 Pause fatigued ad" },
];

const rules = (message: string) => normalizeBrief(rulesBrief(message, shown), message, shown);

describe("a negated message does not queue what it excludes (keyword fallback)", () => {
  it.each([
    "don't queue #2",
    "do not queue the budget changes",
    "Don't apply these changes yet, just show me the budget recommendations",
    "don't queue anything yet, what should I fix in budget?",
    "please don't queue anything",
    "I don't want you to queue #2",
    "no need to queue these",
  ])("%s", (message) => {
    const b = rules(message);
    expect(b.queue.requested).toBe(false);
    expect(b.mode).toBe("analyse");
    expect(b.queue.refs).toEqual([]);
  });

  it("keeps the analysis the operator did ask for", () => {
    const b = rules("don't queue anything yet, what should I fix in budget?");
    expect(b.optimizationAsk).toBe(true);
    expect(b.focus).toEqual(["budget"]);
  });

  it("queue #1 but not #2: only #1, and #2 is recorded as left out", () => {
    const b = rules("queue #1 but not #2");
    expect(b.queue).toMatchObject({ requested: true, refs: [1], exceptRefs: [2] });
  });

  it("queue everything except #2: all, minus #2", () => {
    const b = rules("queue everything except #2");
    expect(b.queue).toMatchObject({ requested: true, all: true, refs: [], exceptRefs: [2] });
  });

  it("a range with a hole", () => {
    const b = rules("queue #1-#3 except #2");
    expect(b.queue).toMatchObject({ requested: true, refs: [1, 3], exceptRefs: [2] });
  });

  it("an area, minus a name", () => {
    const b = rules("queue the budget ones but leave Brand alone");
    expect(b.queue).toMatchObject({ requested: true, focus: ["budget"] });
    expect(b.exclude).toEqual(["Brand"]);
  });

  it("an area, minus another area", () => {
    const b = rules("queue the budget changes but not the placement ones");
    expect(b.queue).toMatchObject({ requested: true, focus: ["budget"], exceptFocus: ["placements"] });
    expect(b.focus).toEqual(["budget"]);
  });

  it("everything, minus an area", () => {
    const b = rules("queue everything except the budget changes");
    expect(b.queue).toMatchObject({ requested: true, all: true, exceptFocus: ["budget"] });
  });

  it("a number and a name left alone", () => {
    const b = rules("queue #1 and don't touch the Brand campaign");
    expect(b.queue).toMatchObject({ requested: true, refs: [1] });
    expect(b.exclude).toEqual(["Brand"]);
    expect(b.scope.mentions).not.toContain("Brand");
  });

  it("a leading negator on something else does not cancel the instruction", () => {
    expect(rules("don't wait, queue #1").queue).toMatchObject({ requested: true, refs: [1] });
  });

  it("plain instructions are unchanged", () => {
    expect(rules("queue #2").queue).toMatchObject({ requested: true, refs: [2] });
    expect(rules("queue #2 and #3").queue).toMatchObject({ requested: true, refs: [2, 3] });
    expect(rules("apply all of these").queue).toMatchObject({ requested: true, all: true });
  });
});

describe("a negated message does not queue what it excludes (model reply)", () => {
  const reply = (over: Record<string, unknown>) =>
    JSON.stringify({
      intent: "optimize",
      mode: "act",
      focus: [],
      scope: [],
      optimizationAsk: false,
      queue: { requested: true, all: false, refs: [], focus: [], entities: [] },
      exclude: [],
      ...over,
    });
  const parse = (message: string, over: Record<string, unknown>) => {
    const b = parseBriefReply(reply(over), message, shown);
    expect(b).not.toBeNull();
    return normalizeBrief(b!, message, shown);
  };

  it("a model that misses the negation is overruled: nothing is queued", () => {
    const b = parse("don't queue #2", { queue: { requested: true, all: false, refs: [2], focus: [], entities: [] } });
    expect(b.queue.requested).toBe(false);
    expect(b.mode).toBe("analyse");
  });

  it("a model that says 'all' for 'everything except #2' still leaves #2 out", () => {
    const b = parse("queue everything except #2", { queue: { requested: true, all: true, refs: [], focus: [], entities: [] } });
    expect(b.queue).toMatchObject({ requested: true, all: true, exceptRefs: [2] });
  });

  it("a model that includes the excluded number is corrected", () => {
    const b = parse("queue #1 but not #2", { queue: { requested: true, all: false, refs: [1, 2], focus: [], entities: [] } });
    expect(b.queue.refs).toEqual([1]);
    expect(b.queue.exceptRefs).toEqual([2]);
  });

  it("the model's own excluded numbers are kept", () => {
    const b = parse("queue all of them but skip the second one", {
      queue: { requested: true, all: true, refs: [], focus: [], entities: [], exceptRefs: [2] },
    });
    expect(b.queue.exceptRefs).toEqual([2]);
  });

  it("an excluded name from the typed text is added even if the model forgot it", () => {
    const b = parse("queue the budget ones but leave Brand alone", {
      focus: ["budget"],
      queue: { requested: true, all: false, refs: [], focus: ["budget"], entities: [] },
    });
    expect(b.exclude).toContain("Brand");
  });
});

describe("kinds of change and queue words (keyword fallback)", () => {
  it("a direct instruction is not a queue request, even with an optimise word in it", () => {
    const b = rules("pause the Retargeting ad set to optimise spend");
    expect(b.queue).toMatchObject({ requested: true, phrased: false, kinds: ["pause"], entities: ["Retargeting"] });
    expect(b.optimizationAsk).toBe(true);
  });

  it("'queue the budget increases' names an area and a kind", () => {
    expect(rules("queue the budget increases").queue).toMatchObject({
      requested: true,
      phrased: true,
      focus: ["budget"],
      kinds: ["increase"],
    });
    expect(rules("queue the scale ups").queue).toMatchObject({ requested: true, kinds: ["increase"] });
    expect(rules("queue the budget cuts").queue).toMatchObject({ requested: true, kinds: ["decrease"] });
    expect(rules("queue the pauses").queue).toMatchObject({ requested: true, phrased: true, kinds: ["pause"] });
  });

  it("an instruction with the name before the type word still finds the name", () => {
    const b = rules("lower the Brand campaign budget to 40");
    expect(b.queue).toMatchObject({ requested: true, phrased: false, kinds: ["decrease"], entities: ["Brand"] });
    expect(rules("raise the Leads ad set budget by 20%").queue).toMatchObject({ kinds: ["increase"], entities: ["Leads"] });
  });

  it("a set-budget instruction names no kind of its own, only the area", () => {
    const b = rules("set the daily budget of the Brand campaign to 60");
    expect(b.queue).toMatchObject({ requested: true, phrased: false, entities: ["Brand"] });
    expect(b.queue.kinds ?? []).toEqual([]);
    expect(b.focus).toEqual(["budget"]);
  });

  it("a question about a number is not an instruction to queue it", () => {
    const b = rules("queue #1, what about #2?");
    expect(b.queue.refs).toEqual([1]);
  });

  it("a name with a dash or brackets is kept whole", () => {
    expect(rules('pause the "Retargeting – AU" ad set').scope.mentions).toEqual(["Retargeting – AU"]);
    expect(rules("pause the Leads (AU) ad set").scope.mentions).toEqual(["Leads (AU)"]);
  });
});

describe("'turn off' and 'stop' about a feature are not a pause", () => {
  it("turning off a placement is a placement change, not pausing the ad set", () => {
    for (const message of [
      "turn off audience network on the Leads ad set",
      "stop showing on audience network for the Leads ad set",
      "switch off reels on the Leads ad set",
    ]) {
      const b = rules(message);
      expect(b.queue.kinds ?? [], message).toEqual([]);
      expect(b.focus, message).toContain("placements");
    }
  });

  it("pausing something is still a pause, whatever its name contains", () => {
    expect(rules("pause the Audience Network Test ad set").queue.kinds).toEqual(["pause"]);
    expect(rules("turn off the Brand campaign").queue.kinds).toEqual(["pause"]);
    expect(rules("stop the Brand campaign").queue.kinds).toEqual(["pause"]);
  });

  it("switching a campaign on is a resume; turning a feature on is not", () => {
    expect(rules("switch on the Old Winner campaign").queue.kinds).toEqual(["resume"]);
    expect(rules("turn on audience network for the Leads ad set").queue.kinds ?? []).toEqual([]);
  });
});
