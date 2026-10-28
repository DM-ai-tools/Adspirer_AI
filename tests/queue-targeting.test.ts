import { describe, expect, it } from "vitest";
import type { AgentToolCallProposal } from "@/lib/agent/adspirer-agent";
import type { OfferedProposal } from "@/lib/agent/optimize-evidence";
import { resolveEntityIds } from "@/lib/agent/optimize-evidence";
import { renderQueueDecisionEvidence, selectForQueue } from "@/lib/agent/queue-selection";
import { EMPTY_QUEUE, type RequestBrief } from "@/lib/agent/request-brief";

const ACCOUNT = "act_1";
const PERIOD = { since: "2026-10-21", until: "2026-10-27", label: "last 7 days", explicit: false };

const mk = (o: Omit<OfferedProposal, "spendAtStakeCents">): OfferedProposal => ({ spendAtStakeCents: null, ...o });
const A1 = mk({ ref: 1, tool: "update_adset_budget", focus: "budget", entityIds: ["as_a"], label: "Scale A", args: { account_id: ACCOUNT, adset_id: "as_a", daily_budget_cents: 2400, previous_daily_budget_cents: 2000 } });
const B2 = mk({ ref: 2, tool: "update_adset_budget", focus: "budget", entityIds: ["as_b"], label: "Trim B", args: { account_id: ACCOUNT, adset_id: "as_b", daily_budget_cents: 1600, previous_daily_budget_cents: 2000 } });
const C3 = mk({ ref: 3, tool: "pause_adset", focus: "budget", entityIds: ["as_c"], label: "Pause C", args: { account_id: ACCOUNT, adset_id: "as_c" } });
const D4 = mk({ ref: 4, tool: "update_adset_placements", focus: "placements", entityIds: ["as_c"], label: "Drop Audience Network on C", args: { account_id: ACCOUNT, adset_id: "as_c", publisher_platforms: ["facebook", "instagram"] } });
const LIST = [A1, B2, C3, D4];

const brief = (over: {
  queue?: Partial<NonNullable<RequestBrief["queue"]>>;
  focus?: RequestBrief["focus"];
  optimizationAsk?: boolean;
  exclude?: string[];
}): RequestBrief => ({
  intent: "optimize",
  mode: "act",
  focus: over.focus ?? [],
  scope: { mentions: [] },
  exclude: over.exclude ?? [],
  period: PERIOD,
  queue: { ...EMPTY_QUEUE, requested: true, ...over.queue },
  optimizationAsk: over.optimizationAsk ?? false,
  source: "rules",
});

type Over = {
  offered?: OfferedProposal[];
  previousOffer?: OfferedProposal[] | null;
  writerCalls?: AgentToolCallProposal[];
  named?: string[];
  direct?: string[];
  excluded?: string[];
};
const select = (b: RequestBrief, o: Over = {}) =>
  selectForQueue({
    brief: b,
    offered: o.offered ?? LIST,
    previousOffer: o.previousOffer === undefined ? LIST : o.previousOffer,
    writerCalls: o.writerCalls ?? [],
    namedEntityIds: o.named ?? [],
    directEntityIds: o.direct ?? o.named ?? [],
    excludedEntityIds: o.excluded ?? [],
  });
const queued = (d: { queue: AgentToolCallProposal[] }) =>
  d.queue.map((c) => `${c.name}:${c.args.adset_id ?? c.args.ad_id ?? c.args.campaign_id}`);
const why = (d: { skipped: Array<{ label: string; reason: string }> }) => d.skipped.map((s) => `${s.label} | ${s.reason}`).join("\n");

// The Brand campaign has two ad sets and an ad: naming the campaign puts all of them in scope
// for reading, but only the campaign itself is something the operator asked to change.
const TREE = ["c_brand", "as_a", "as_b", "ad_1"];

describe("a direct instruction queues only the thing that was named", () => {
  const writer: AgentToolCallProposal[] = [
    { name: "pause_campaign", args: { account_id: ACCOUNT, campaign_id: "c_brand" } },
    { name: "update_adset_budget", args: { account_id: ACCOUNT, adset_id: "as_a", daily_budget_cents: 900000 } },
    { name: "create_ad", args: { account_id: ACCOUNT, adset_id: "as_b", name: "new" } },
    { name: "update_adset_placements", args: { account_id: ACCOUNT, adset_id: "as_b", publisher_platforms: ["facebook"] } },
  ];

  it("pause the Brand campaign: the pause, not changes to its ad sets", () => {
    const d = select(brief({ queue: { entities: ["Brand"], kinds: ["pause"] } }), {
      offered: [], previousOffer: null, writerCalls: writer, named: TREE, direct: ["c_brand"],
    });
    expect(queued(d)).toEqual(["pause_campaign:c_brand"]);
    expect(d.skipped).toHaveLength(3);
  });

  it("a create tool is never a direct instruction, even with nothing else to go on", () => {
    const d = select(brief({ queue: { entities: ["Brand"] } }), {
      offered: [], previousOffer: null,
      writerCalls: [{ name: "create_ad", args: { account_id: ACCOUNT, adset_id: "as_b", name: "new" } }],
      named: ["as_b"], direct: ["as_b"],
    });
    expect(d.queue).toEqual([]);
    expect(why(d)).toMatch(/not something you asked/);
  });

  it("set the daily budget of the Brand campaign: the campaign budget only", () => {
    const d = select(brief({ focus: ["budget"], queue: { entities: ["Brand"] } }), {
      offered: [], previousOffer: null,
      writerCalls: [
        { name: "update_campaign_budget", args: { account_id: ACCOUNT, campaign_id: "c_brand", daily_budget_cents: 6000 } },
        { name: "pause_adset", args: { account_id: ACCOUNT, adset_id: "as_b" } },
        { name: "update_adset_budget", args: { account_id: ACCOUNT, adset_id: "as_a", daily_budget_cents: 6000 } },
      ],
      named: TREE, direct: ["c_brand"],
    });
    expect(queued(d)).toEqual(["update_campaign_budget:c_brand"]);
  });

  it("a pause instruction does not let a budget change through", () => {
    const d = select(brief({ focus: ["budget"], queue: { entities: ["Retargeting"], kinds: ["pause"] } }), {
      offered: [], previousOffer: null,
      writerCalls: [
        { name: "update_adset_budget", args: { account_id: ACCOUNT, adset_id: "as_r", daily_budget_cents: 100 } },
        { name: "pause_adset", args: { account_id: ACCOUNT, adset_id: "as_r" } },
      ],
      named: ["as_r"],
    });
    expect(queued(d)).toEqual(["pause_adset:as_r"]);
  });

  it("a resume instruction does not let a pause through", () => {
    const d = select(brief({ queue: { entities: ["Old"], kinds: ["resume"] } }), {
      offered: [], previousOffer: null,
      writerCalls: [{ name: "pause_adset", args: { account_id: ACCOUNT, adset_id: "as_o" } }],
      named: ["as_o"],
    });
    expect(d.queue).toEqual([]);
  });

  it("raise the budget: a budget change goes through, a pause does not", () => {
    const d = select(brief({ focus: ["budget"], queue: { entities: ["Leads"], kinds: ["increase"] } }), {
      offered: [], previousOffer: null,
      writerCalls: [
        { name: "pause_adset", args: { account_id: ACCOUNT, adset_id: "as_l" } },
        { name: "update_adset_budget", args: { account_id: ACCOUNT, adset_id: "as_l", daily_budget_cents: 7000 } },
      ],
      named: ["as_l"],
    });
    expect(queued(d)).toEqual(["update_adset_budget:as_l"]);
  });

  it("an offered proposal that is exactly what was asked is queued from the code-built list", () => {
    const d = select(brief({ queue: { entities: ["C"], kinds: ["pause"] } }), {
      writerCalls: [{ name: "pause_adset", args: { account_id: ACCOUNT, adset_id: "as_c", extra: "writer's own" } }],
      named: ["as_c"],
    });
    expect(queued(d)).toEqual(["pause_adset:as_c"]);
    expect(d.queue[0]!.args).toEqual(C3.args);
    expect(d.queuedRefs).toEqual([3]);
  });

  it("pause X to optimise spend (an optimise word, no queue word): the pause only, not every proposal for X", () => {
    const d = select(brief({ focus: ["budget"], optimizationAsk: true, queue: { entities: ["C"], kinds: ["pause"], phrased: false } }), {
      previousOffer: null, named: ["as_c"],
    });
    expect(queued(d)).toEqual(["pause_adset:as_c"]);
    expect(why(d)).not.toMatch(/Drop Audience Network/);
  });

  it("an instruction naming something and nothing doable queues nothing and says so", () => {
    const d = select(brief({ queue: { entities: ["Ghost"], kinds: ["pause"] } }), {
      offered: [], previousOffer: null, writerCalls: [], named: [],
    });
    expect(d.queue).toEqual([]);
    expect(d.skipped.length).toBeGreaterThan(0);
  });
});

describe("queue by area and kind", () => {
  it("'the budget increases' is not every budget change", () => {
    const d = select(brief({ focus: ["budget"], queue: { focus: ["budget"], kinds: ["increase"], phrased: true } }));
    expect(d.queuedRefs).toEqual([1]);
  });

  it("'the budget cuts'", () => {
    const d = select(brief({ focus: ["budget"], queue: { focus: ["budget"], kinds: ["decrease"], phrased: true } }));
    expect(d.queuedRefs).toEqual([2]);
  });

  it("'the pauses' picks pauses in any area, and no other change", () => {
    const d = select(brief({ queue: { kinds: ["pause"], phrased: true } }));
    expect(d.queuedRefs).toEqual([3]);
  });

  it("numbers win over a kind word", () => {
    const d = select(brief({ queue: { refs: [2], kinds: ["increase"], phrased: true } }));
    expect(d.queuedRefs).toEqual([2]);
  });
});

describe("what the operator left out", () => {
  it("everything except #2", () => {
    const d = select(brief({ queue: { all: true, exceptRefs: [2], phrased: true } }));
    expect(d.queuedRefs).toEqual([1, 3, 4]);
    expect(why(d)).toMatch(/#2 Trim B \| you asked me to leave that out/);
  });

  it("#1 and #2 except #2", () => {
    const d = select(brief({ queue: { refs: [1, 2], exceptRefs: [2], phrased: true } }));
    expect(d.queuedRefs).toEqual([1]);
  });

  it("the budget changes except the placement ones", () => {
    const d = select(brief({ queue: { all: true, exceptFocus: ["placements"], phrased: true } }));
    expect(d.queuedRefs).toEqual([1, 2, 3]);
    expect(why(d)).toMatch(/Drop Audience Network on C/);
  });

  it("the area minus a number", () => {
    const d = select(brief({ focus: ["budget"], queue: { focus: ["budget"], exceptRefs: [1], phrased: true } }));
    expect(d.queuedRefs).toEqual([2, 3]);
  });
});

describe("optimise and queue 'all of them' in one message", () => {
  it("means this turn's list, not an older one", () => {
    const d = select(brief({ optimizationAsk: true, queue: { all: true, phrased: true } }), {
      offered: [A1], previousOffer: [B2],
    });
    expect(d.queuedRefs).toEqual([1]);
    expect(queued(d)).toEqual(["update_adset_budget:as_a"]);
  });
});

describe("what the writer is told before it writes", () => {
  it("a direct instruction is not announced as 'nothing queued, final'", () => {
    const b = brief({ queue: { entities: ["Retargeting"], kinds: ["pause"] } });
    const d = select(b, { offered: [], previousOffer: null, named: ["as_r"] });
    const text = renderQueueDecisionEvidence(b, d);
    expect(text).not.toMatch(/Queued in Approvals: nothing/);
    expect(text).toMatch(/asked for this change directly/i);
    expect(text).toMatch(/Retargeting/);
    expect(text).toMatch(/tool JSON/i);
  });

  it("a reference turn keeps the final wording", () => {
    const b = brief({ queue: { refs: [1], phrased: true } });
    expect(renderQueueDecisionEvidence(b, select(b))).toMatch(/This decision is final/);
  });
});

describe("resolving what the operator named", () => {
  const inventory = {
    campaigns: [{ id: "c_brand", name: "Brand", status: "ACTIVE", objective: "OUTCOME_SALES" }],
    adsets: [
      { id: "as_a", name: "Brand – Broad", campaign_id: "c_brand", status: "ACTIVE", daily_budget_cents: 2000 },
      { id: "as_b", name: "Brand – Retargeting", campaign_id: "c_brand", status: "ACTIVE", daily_budget_cents: 2000 },
    ],
    ads: [{ id: "ad_1", name: "Video", adset_id: "as_a", campaign_id: "c_brand", status: "ACTIVE" }],
  } as never;

  it("a campaign puts its ad sets and ads in scope, but only the campaign itself is the thing to change", () => {
    const named = resolveEntityIds(["Brand"], inventory);
    expect([...named.ids].sort()).toEqual(["ad_1", "as_a", "as_b", "c_brand"]);
    expect([...named.direct]).toEqual(["c_brand"]);
  });

  it("an ad set named by its full name is the direct target, with its ads only in scope", () => {
    const named = resolveEntityIds(["Brand – Broad"], inventory);
    expect([...named.direct]).toEqual(["as_a"]);
    expect([...named.ids].sort()).toEqual(["ad_1", "as_a"]);
  });

  it("a name that matches nothing is reported, never widened", () => {
    const named = resolveEntityIds(["Ghost"], inventory);
    expect(named.unresolved).toEqual(["Ghost"]);
    expect(named.direct.size).toBe(0);
  });
});

describe("an instruction that names no kind of change and no area", () => {
  const writer: AgentToolCallProposal[] = [
    { name: "update_adset_audience_exclusions", args: { account_id: ACCOUNT, adset_id: "as_p", add_excluded_custom_audiences: ["123"] } },
    { name: "update_adset_budget", args: { account_id: ACCOUNT, adset_id: "as_p", daily_budget_cents: 9900 } },
  ];

  it("queues one change, the first, and says the rest need their own request", () => {
    const d = select(brief({ queue: { entities: ["Prospecting"], phrased: false } }), {
      offered: [], previousOffer: null, writerCalls: writer, named: ["as_p"],
    });
    expect(queued(d)).toEqual(["update_adset_audience_exclusions:as_p"]);
    expect(why(d)).toMatch(/update_adset_budget|Update ad set budget/i);
    expect(why(d)).toMatch(/one change/i);
  });

  it("an area names the change, so that guard does not apply", () => {
    const d = select(brief({ focus: ["audiences", "budget"], queue: { entities: ["Prospecting"], phrased: false } }), {
      offered: [], previousOffer: null, writerCalls: writer, named: ["as_p"],
    });
    expect(queued(d)).toHaveLength(2);
  });

  it("a pause in the live list is not taken for 'turn off audience network' (no kind was named)", () => {
    const d = select(brief({ focus: ["placements"], queue: { entities: ["C"], phrased: false } }), {
      previousOffer: null, named: ["as_c"],
    });
    expect(d.queue).toEqual([]);
  });
});
