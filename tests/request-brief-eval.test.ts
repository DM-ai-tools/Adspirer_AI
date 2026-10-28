import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentHistoryMessage } from "@/lib/agent/history";
import { normalizeBrief, parseBriefReply, rulesBrief, type RequestBrief } from "@/lib/agent/request-brief";
import type { Focus } from "@/lib/agent/optimization-capabilities";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-28T10:00:00Z"));
});
afterEach(() => vi.useRealTimers());

const shown: AgentHistoryMessage[] = [
  { role: "user", content: "optimize my budget" },
  {
    role: "assistant",
    content:
      "Budget optimisation for last 7 days. #1 Scale Leads ad set +20%. #2 Trim Brand ad set -20%. #3 Pause Retargeting ad set. Nothing is queued in Approvals yet.",
  },
];
const report: AgentHistoryMessage[] = [
  { role: "user", content: "audit the whole account for the last 30 days" },
  { role: "assistant", content: `Meta Ads Account Audit\n${"F2 Frequency within healthy range Pass. ".repeat(40)}` },
];

type Expect = {
  intent?: RequestBrief["intent"];
  mode?: "analyse" | "act";
  focus?: Focus[];
  mentions?: string[];
  exclude?: string[];
  optimizationAsk?: boolean;
  period?: { since: string; until: string; explicit: boolean } | null;
  queue?: Partial<RequestBrief["queue"]>;
};
type Case = { message: string; history?: AgentHistoryMessage[]; expect: Expect };

const LAST_7 = { since: "2026-10-21", until: "2026-10-27", explicit: false };

const CASES: Case[] = [
  // ---- optimisation asks, in the operator's own words
  { message: "optimise mah budgets", expect: { intent: "optimize", mode: "analyse", focus: ["budget"], optimizationAsk: true, period: LAST_7 } },
  { message: "what should i fix first", expect: { intent: "optimize", mode: "analyse", optimizationAsk: true } },
  { message: "optimise the placements", expect: { intent: "optimize", mode: "analyse", focus: ["placements"] } },
  { message: "optimise just the budget", expect: { intent: "optimize", mode: "analyse", focus: ["budget"] } },
  { message: "how can i improve my ads", expect: { intent: "optimize", mode: "analyse", optimizationAsk: true } },
  { message: "optimize my ads from 1 Oct to 15 Oct", expect: { intent: "optimize", period: { since: "2026-10-01", until: "2026-10-15", explicit: true } } },
  { message: "optimize campaign Leads Brisbane for last 14 days", expect: { intent: "optimize", mode: "analyse", mentions: ["Leads Brisbane"], period: { since: "2026-10-14", until: "2026-10-27", explicit: true } } },
  { message: 'optimise campaign "TR | Lead Gen" over the last 7 days', expect: { intent: "optimize", mentions: ["TR | Lead Gen"], period: { since: "2026-10-21", until: "2026-10-27", explicit: true } } },
  { message: "don't touch the Brand campaign, optimise the rest", expect: { intent: "optimize", mode: "analyse", exclude: ["Brand"], mentions: [] } },
  { message: "optimise everything except the Brand campaign", expect: { intent: "optimize", exclude: ["Brand"], mentions: [] } },
  { message: "give me the optimization steps", history: report, expect: { intent: "optimize", mode: "analyse", optimizationAsk: true } },

  // ---- direct instructions: act, naming what to change
  { message: "pls pause the retargeting adset", expect: { intent: "optimize", mode: "act", queue: { requested: true, entities: ["retargeting"], all: false, focus: [] } } },
  { message: 'pause the "Retargeting – AU" ad set', expect: { intent: "optimize", mode: "act", mentions: ["Retargeting – AU"], queue: { entities: ["Retargeting – AU"] } } },
  { message: "resume the Old winner campaign", expect: { intent: "optimize", mode: "act", focus: ["reactivation"], mentions: ["Old winner"] } },
  { message: 'set the daily budget of "Leads A" ad set to 60', expect: { intent: "optimize", mode: "act", focus: ["budget"], mentions: ["Leads A"], queue: { focus: [], all: false } } },
  { message: "increase budget for campaign Brand by 20%", expect: { intent: "optimize", mode: "act", focus: ["budget"], mentions: ["Brand"] } },
  { message: "exclude audience network from the Leads ad set", expect: { intent: "optimize", mode: "act", focus: ["placements"], mentions: ["Leads"] } },
  { message: "remove audience network placements", expect: { intent: "optimize", mode: "act", focus: ["placements"], mentions: [], queue: { entities: [] } } },

  // ---- queueing what was shown
  { message: "queue #2 and #3", history: shown, expect: { intent: "optimize", mode: "act", queue: { requested: true, refs: [2, 3], all: false } } },
  { message: "queue #1-#3", history: shown, expect: { mode: "act", queue: { refs: [1, 2, 3] } } },
  { message: "queue all of these", history: shown, expect: { mode: "act", queue: { requested: true, all: true, refs: [] } } },
  { message: "apply all of these", history: shown, expect: { mode: "act", queue: { all: true } } },
  { message: "send these to approvals", history: shown, expect: { mode: "act", queue: { all: true } } },
  { message: "send everything you suggested to approvals", history: shown, expect: { mode: "act", queue: { all: true } } },
  { message: "yes queue them", history: shown, expect: { mode: "act", queue: { all: true } } },
  { message: "queue the budget changes", history: shown, expect: { mode: "act", queue: { requested: true, focus: ["budget"], all: false, refs: [] } } },
  { message: "leave the Brand campaign alone and queue the budget changes", history: shown, expect: { mode: "act", exclude: ["Brand"], mentions: [], queue: { focus: ["budget"], entities: [] } } },
  { message: "queue all of these but don't touch the Brand campaign", history: shown, expect: { mode: "act", exclude: ["Brand"], queue: { all: true, entities: [] } } },
  { message: "optimise and queue it", expect: { intent: "optimize", mode: "act", optimizationAsk: true, queue: { requested: true } } },

  // ---- questions and chatter never act
  { message: "should I pause the Brand ad set?", history: shown, expect: { mode: "analyse", queue: { requested: false } } },
  { message: "what if I raised the budget", history: shown, expect: { mode: "analyse", queue: { requested: false } } },
  { message: "which of these can you do?", history: report, expect: { intent: "followup", mode: "analyse", optimizationAsk: false } },
  { message: "how is spend pacing?", expect: { mode: "analyse", optimizationAsk: false, queue: { requested: false } } },
  { message: "thanks", expect: { intent: "chat", mode: "analyse", period: null } },
  { message: "hi", expect: { intent: "chat", period: null } },
  { message: "what does CPM mean", expect: { intent: "chat", mode: "analyse" } },

  // ---- other flows keep their own intents
  { message: "audit this account for the last 30 days", expect: { intent: "audit", mode: "analyse", queue: { requested: false } } },
  { message: "audit campaign Leads Brisbane", expect: { intent: "audit", mentions: ["Leads Brisbane"], queue: { requested: false } } },
];

const classify = (c: Case) => normalizeBrief(rulesBrief(c.message, c.history ?? []), c.message, c.history ?? []);

describe("request brief: phrasings through the keyword rules", () => {
  it("has the cases the review asked for", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(30);
  });

  for (const c of CASES) {
    it(`"${c.message}"${c.history === shown ? " (after a numbered list)" : c.history === report ? " (after an audit)" : ""}`, () => {
      const brief = classify(c);
      const e = c.expect;
      if (e.intent) expect(brief.intent).toBe(e.intent);
      if (e.mode) expect(brief.mode).toBe(e.mode);
      if (e.focus) expect(brief.focus).toEqual(e.focus);
      if (e.mentions) expect(brief.scope.mentions).toEqual(e.mentions);
      if (e.exclude) expect(brief.exclude).toEqual(e.exclude);
      if (e.optimizationAsk !== undefined) expect(brief.optimizationAsk).toBe(e.optimizationAsk);
      if (e.period === null) expect(brief.period).toBeNull();
      else if (e.period) expect(brief.period).toMatchObject(e.period);
      if (e.queue) expect(brief.queue).toMatchObject(e.queue);
      // Nothing is ever queued unless the operator asked for changes.
      if (brief.mode === "analyse") expect(brief.queue).toEqual({ requested: false, all: false, refs: [], focus: [], entities: [] });
    });
  }
});

/** The JSON a model would return for this brief. */
const asModelReply = (b: RequestBrief) =>
  JSON.stringify({
    intent: b.intent,
    mode: b.mode,
    focus: b.focus,
    scope: b.scope.mentions,
    periodStated: Boolean(b.period?.explicit),
    optimizationAsk: b.optimizationAsk,
    queue: b.queue,
    exclude: b.exclude,
  });

describe("request brief: the same phrasings through the model's reply", () => {
  for (const c of CASES) {
    it(`"${c.message}" gets the same brief from a model's JSON, with dates worked out in code`, () => {
      const rules = rulesBrief(c.message, c.history ?? []);
      const model = parseBriefReply(asModelReply(rules), c.message, c.history ?? []);
      expect(model).not.toBeNull();
      expect(model).toMatchObject({
        intent: rules.intent,
        mode: rules.mode,
        focus: rules.focus,
        scope: rules.scope,
        exclude: rules.exclude,
        queue: rules.queue,
        period: rules.period,
        optimizationAsk: rules.optimizationAsk,
        source: "model",
      });
    });
  }

  it("a model that invents an entity or a date changes nothing: only what was typed counts", () => {
    const reply = JSON.stringify({
      intent: "optimize",
      mode: "act",
      focus: ["budget"],
      scope: ["Ghost Campaign"],
      periodStated: true,
      period: { since: "1999-01-01", until: "1999-01-02" },
      optimizationAsk: false,
      queue: { requested: true, all: false, refs: [], focus: [], entities: ["Ghost Campaign"] },
      exclude: ["Another Ghost"],
    });
    const brief = parseBriefReply(reply, "pause something for me", [])!;
    expect(brief.scope.mentions).toEqual([]);
    expect(brief.queue.entities).toEqual([]);
    expect(brief.exclude).toEqual([]);
    expect(brief.period).toMatchObject({ since: "2026-10-21", until: "2026-10-27", explicit: false });
  });
});
