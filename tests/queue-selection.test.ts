import { describe, expect, it } from "vitest";
import type { AgentToolCallProposal } from "@/lib/agent/adspirer-agent";
import type { OfferedProposal } from "@/lib/agent/optimize-evidence";
import {
  adoptOfferContext,
  isReferencingQueue,
  renderQueueDecisionEvidence,
  renderQueueBlock,
  selectForQueue,
  stripQueuedClaims,
  type StoredOffer,
} from "@/lib/agent/queue-selection";
import { EMPTY_QUEUE, type RequestBrief } from "@/lib/agent/request-brief";

const ACCOUNT = "act_1";
const PERIOD = { since: "2026-10-21", until: "2026-10-27", label: "last 7 days", explicit: false };

const item = (over: Partial<OfferedProposal> & Pick<OfferedProposal, "ref" | "tool" | "focus" | "entityIds" | "args">): OfferedProposal => ({
  label: `${over.tool} ${over.entityIds.join(",")}`,
  spendAtStakeCents: null,
  ...over,
});

const A1 = item({ ref: 1, tool: "update_adset_budget", focus: "budget", entityIds: ["as_a"], label: "Scale ad set A", args: { account_id: ACCOUNT, adset_id: "as_a", daily_budget_cents: 2400, previous_daily_budget_cents: 2000 } });
const B2 = item({ ref: 2, tool: "update_adset_budget", focus: "budget", entityIds: ["as_b"], label: "Trim ad set B", args: { account_id: ACCOUNT, adset_id: "as_b", daily_budget_cents: 1600, previous_daily_budget_cents: 2000 } });
const C3 = item({ ref: 3, tool: "pause_ad", focus: "creative", entityIds: ["ad_x"], label: "Pause fatigued ad X", args: { account_id: ACCOUNT, ad_id: "ad_x" } });
const D4 = item({ ref: 4, tool: "resume_campaign", focus: "reactivation", entityIds: ["c_old"], label: "Reactivate Old winner", args: { account_id: ACCOUNT, campaign_id: "c_old" } });
const FIXTURE = [A1, B2, C3, D4];

const brief = (over: {
  mode?: "analyse" | "act";
  queue?: Partial<RequestBrief["queue"]>;
  focus?: RequestBrief["focus"];
  optimizationAsk?: boolean;
  exclude?: string[];
} = {}): RequestBrief => ({
  intent: "optimize",
  mode: over.mode ?? "act",
  focus: over.focus ?? [],
  scope: { mentions: [] },
  exclude: over.exclude ?? [],
  period: PERIOD,
  queue: { ...EMPTY_QUEUE, requested: (over.mode ?? "act") === "act", ...over.queue },
  optimizationAsk: over.optimizationAsk ?? false,
  source: "rules",
});

const select = (b: RequestBrief, over: { offered?: OfferedProposal[]; previousOffer?: OfferedProposal[] | null; writerCalls?: AgentToolCallProposal[]; namedEntityIds?: string[]; directEntityIds?: string[]; excludedEntityIds?: string[] } = {}) =>
  selectForQueue({
    brief: b,
    offered: over.offered ?? FIXTURE,
    previousOffer: over.previousOffer === undefined ? FIXTURE : over.previousOffer,
    writerCalls: over.writerCalls ?? [],
    namedEntityIds: over.namedEntityIds ?? [],
    directEntityIds: over.directEntityIds ?? over.namedEntityIds ?? [],
    excludedEntityIds: over.excludedEntityIds ?? [],
  });

const names = (d: { queue: AgentToolCallProposal[] }) => d.queue.map((c) => `${c.name}:${c.args.adset_id ?? c.args.ad_id ?? c.args.campaign_id}`);
const reasons = (d: { skipped: Array<{ label: string; reason: string }> }) => d.skipped.map((s) => `${s.label} | ${s.reason}`).join("\n");

describe("nothing is queued unless the operator asked", () => {
  it("analyse mode queues nothing, even when the writer emitted a change", () => {
    const d = select(brief({ mode: "analyse" }), {
      writerCalls: [{ name: "update_adset_budget", args: A1.args }],
      namedEntityIds: ["as_a"],
    });
    expect(d.queue).toEqual([]);
    expect(d.queuedRefs).toEqual([]);
    expect(reasons(d)).toMatch(/only queued when you ask/);
  });

  it("act without a queue request queues nothing", () => {
    const b = brief({ mode: "act" });
    expect(select({ ...b, queue: { ...EMPTY_QUEUE } }).queue).toEqual([]);
  });

  it("a vague queue request says how to be specific and queues nothing", () => {
    const d = select(brief({ queue: { requested: true } }));
    expect(d.queue).toEqual([]);
    expect(reasons(d)).toMatch(/by number/);
  });
});

describe("queue by reference to what was shown", () => {
  it("refs select exactly those proposals", () => {
    const d = select(brief({ queue: { requested: true, refs: [2] } }));
    expect(names(d)).toEqual(["update_adset_budget:as_b"]);
    expect(d.queuedRefs).toEqual([2]);
    expect(d.labels).toEqual(["#2 Trim ad set B"]);
    expect(d.queue[0]!.args).toEqual(B2.args);
  });

  it("a ref beyond the list is skipped, never guessed", () => {
    const d = select(brief({ queue: { requested: true, refs: [9] } }));
    expect(d.queue).toEqual([]);
    expect(reasons(d)).toMatch(/#9/);
  });

  it("refs with no earlier list queue nothing and say why", () => {
    const d = select(brief({ queue: { requested: true, refs: [1] } }), { previousOffer: null });
    expect(d.queue).toEqual([]);
    expect(reasons(d)).toMatch(/no earlier list/i);
  });

  it("all means what was shown, and only what still applies", () => {
    const d = select(brief({ queue: { requested: true, all: true } }), { offered: [A1, B2, C3] });
    expect(d.queuedRefs).toEqual([1, 2, 3]);
    expect(reasons(d)).toMatch(/Reactivate Old winner/);
    expect(reasons(d)).toMatch(/no longer applies/);
  });

  it("all with no earlier list queues nothing", () => {
    const d = select(brief({ queue: { requested: true, all: true } }), { previousOffer: null });
    expect(d.queue).toEqual([]);
    expect(reasons(d)).toMatch(/no earlier list/i);
  });

  it("a proposal whose numbers changed since it was shown is skipped, not applied from stale numbers", () => {
    const moved = { ...A1, args: { ...A1.args, daily_budget_cents: 2500, previous_daily_budget_cents: 2100 } };
    const d = select(brief({ queue: { requested: true, refs: [1, 2] } }), { offered: [moved, B2, C3, D4] });
    expect(names(d)).toEqual(["update_adset_budget:as_b"]);
    expect(reasons(d)).toMatch(/Scale ad set A/);
    expect(reasons(d)).toMatch(/changed since it was shown/);
  });

  it("queue the budget changes: the budget items that were shown, not the creative or reactivation ones", () => {
    const d = select(brief({ queue: { requested: true, focus: ["budget"] }, focus: ["budget"] }));
    expect(d.queuedRefs).toEqual([1, 2]);
  });

  it("an item that is new since the list was shown is not queued by a focus request", () => {
    const fresh = item({ ref: 5, tool: "pause_adset", focus: "budget", entityIds: ["as_new"], label: "Pause new ad set", args: { account_id: ACCOUNT, adset_id: "as_new" } });
    const d = select(brief({ queue: { requested: true, focus: ["budget"] }, focus: ["budget"] }), { offered: [...FIXTURE, fresh] });
    expect(d.queuedRefs).toEqual([1, 2]);
    expect(reasons(d)).toMatch(/Pause new ad set/);
    expect(reasons(d)).toMatch(/wasn.t in the list/);
  });

  it("a focus request with no earlier list queues nothing", () => {
    const d = select(brief({ queue: { requested: true, focus: ["budget"] } }), { previousOffer: null });
    expect(d.queue).toEqual([]);
    expect(reasons(d)).toMatch(/no earlier list/i);
  });

  it("named entities narrow a reference further", () => {
    const d = select(brief({ queue: { requested: true, all: true, entities: ["B"] } }), { namedEntityIds: ["as_b"] });
    expect(d.queuedRefs).toEqual([2]);
  });

  it("anything the operator said to leave alone is never queued", () => {
    const d = select(brief({ queue: { requested: true, all: true } }), { excludedEntityIds: ["as_b"] });
    expect(d.queuedRefs).toEqual([1, 3, 4]);
    expect(reasons(d)).toMatch(/Trim ad set B/);
    expect(reasons(d)).toMatch(/leave/);
  });
});

describe("optimise and queue in one message", () => {
  it("queues this turn's proposals for the named area only", () => {
    const d = select(brief({ focus: ["budget"], optimizationAsk: true, queue: { requested: true, focus: ["budget"] } }), { previousOffer: null });
    expect(d.queuedRefs).toEqual([1, 2]);
  });

  it("without a named area queues what this turn's optimisation produced", () => {
    const d = select(brief({ optimizationAsk: true, queue: { requested: true } }), { offered: [A1, C3], previousOffer: null });
    expect(d.queuedRefs).toEqual([1, 3]);
  });

  it("ignores an older list", () => {
    const d = select(brief({ focus: ["budget"], optimizationAsk: true, queue: { requested: true } }), { offered: [A1], previousOffer: [B2] });
    expect(d.queuedRefs).toEqual([1]);
  });
});

describe("direct instructions", () => {
  const pause = { name: "pause_adset", args: { account_id: ACCOUNT, adset_id: "as_c" }, rationale: "Operator asked" };

  it("a writer call for a named entity is queued", () => {
    const d = select(brief({ queue: { requested: true, entities: ["C"], kinds: ["pause"] } }), { writerCalls: [pause], namedEntityIds: ["as_c"] });
    expect(names(d)).toEqual(["pause_adset:as_c"]);
  });

  it("a writer call with no entity named is not", () => {
    const d = select(brief({ queue: { requested: true } }), { writerCalls: [pause], namedEntityIds: [] });
    expect(d.queue).toEqual([]);
    expect(reasons(d)).toMatch(/not something you asked/);
  });

  it("a writer call on an entity other than the one named is not", () => {
    const d = select(brief({ queue: { requested: true, entities: ["C"] } }), { writerCalls: [pause], namedEntityIds: ["as_other"] });
    expect(d.queue).toEqual([]);
  });

  it("a writer call whose tool is outside the named area is not", () => {
    const d = select(brief({ focus: ["creative"], queue: { requested: true, entities: ["C"] } }), { writerCalls: [pause], namedEntityIds: ["as_c"] });
    expect(d.queue).toEqual([]);
  });

  it("a writer call on something the operator said to leave alone is not", () => {
    const d = select(brief({ queue: { requested: true, entities: ["C"] } }), { writerCalls: [pause], namedEntityIds: ["as_c"], excludedEntityIds: ["as_c"] });
    expect(d.queue).toEqual([]);
  });

  it("a writer call for the same change as a selected proposal is queued once", () => {
    const d = select(brief({ queue: { requested: true, refs: [1], entities: ["A"] } }), {
      writerCalls: [{ name: "update_adset_budget", args: { ...A1.args, daily_budget_cents: 3000 } }],
      namedEntityIds: ["as_a"],
    });
    expect(d.queue).toHaveLength(1);
    expect(d.queue[0]!.args).toEqual(A1.args);
    expect(reasons(d)).toMatch(/already queued as #1/);
  });

  it("identical calls collapse", () => {
    const d = select(brief({ queue: { requested: true, entities: ["C"], kinds: ["pause"] } }), { writerCalls: [pause, { ...pause }], namedEntityIds: ["as_c"] });
    expect(d.queue).toHaveLength(1);
  });
});

describe("selectForQueue is a pure function", () => {
  it("gives the same answer twice", () => {
    const input = brief({ queue: { requested: true, refs: [1, 3] } });
    expect(select(input)).toEqual(select(input));
  });
});

describe("renderQueueBlock", () => {
  it("lists what was queued and what was not, with reasons", () => {
    const block = renderQueueBlock({ queued: ["#1 Scale ad set A"], notQueued: [{ label: "#2 Trim ad set B", reason: "changed since it was shown" }] });
    expect(block).toContain("### Queued in Approvals (1)");
    expect(block).toContain("- #1 Scale ad set A");
    expect(block).toContain("### Not queued (1)");
    expect(block).toContain("- #2 Trim ad set B: changed since it was shown");
  });

  it("says zero plainly when nothing was queued", () => {
    expect(renderQueueBlock({ queued: [], notQueued: [{ label: "Nothing", reason: "no proposal matched" }] })).toContain("### Queued in Approvals (0)");
  });

  it("reports a change that was already waiting in Approvals instead of calling it new", () => {
    const block = renderQueueBlock({ queued: [], alreadyQueued: ["#1 Scale ad set A"], notQueued: [] });
    expect(block).toContain("### Already in Approvals (1)");
    expect(block).toContain("- #1 Scale ad set A");
    expect(block).toMatch(/still waiting for review/);
    expect(block).not.toContain("Queued in Approvals (0)");
  });

  it("is empty when there is nothing to report", () => {
    expect(renderQueueBlock({ queued: [], notQueued: [] })).toBe("");
  });
});

describe("adoptOfferContext", () => {
  const stored: StoredOffer = {
    createdAt: "2026-10-27T10:00:00Z",
    items: [A1, C3],
    period: { since: "2026-10-01", until: "2026-10-15", label: "1 Oct – 15 Oct", explicit: true },
    scopeMentions: ["Leads Brisbane"],
  };

  it("a queue turn keeps the period, scope and areas of the list it refers to", () => {
    const out = adoptOfferContext(brief({ queue: { requested: true, refs: [1] } }), stored);
    expect(out.period).toMatchObject({ since: "2026-10-01", until: "2026-10-15", explicit: false });
    expect(out.scope.mentions).toEqual(["Leads Brisbane"]);
    expect(out.focus).toEqual(expect.arrayContaining(["budget", "creative"]));
  });

  it("a period or scope the operator states now wins", () => {
    const b = brief({ queue: { requested: true, refs: [1] } });
    const out = adoptOfferContext(
      { ...b, period: { ...PERIOD, explicit: true }, scope: { mentions: ["Brand"] } },
      stored,
    );
    expect(out.period).toEqual({ ...PERIOD, explicit: true });
    expect(out.scope.mentions).toEqual(["Brand"]);
  });

  it("does nothing for a turn that isn't queueing, or when optimising afresh", () => {
    const analyse = brief({ mode: "analyse" });
    expect(adoptOfferContext(analyse, stored)).toEqual(analyse);
    const fresh = brief({ optimizationAsk: true, queue: { requested: true } });
    expect(adoptOfferContext(fresh, stored)).toEqual(fresh);
  });
});

describe("stripQueuedClaims", () => {
  it("removes a sentence that says something was queued", () => {
    const out = stripQueuedClaims("Budget is concentrated in two ad sets. I've queued #1 and #2 in Approvals. Approve them to apply.");
    expect(out).not.toMatch(/queued/);
    expect(out).toContain("Budget is concentrated in two ad sets.");
    expect(out).toContain("Approve them to apply.");
  });

  it("keeps honest statements that nothing is queued yet", () => {
    for (const text of [
      "Nothing is queued in Approvals yet.",
      "Nothing has been queued in Approvals.",
      "These can be queued in Approvals when you ask.",
      "#1 is not queued; say 'queue #1' to send it to Approvals.",
      "Once you approve it, the change will be applied.",
    ]) {
      expect(stripQueuedClaims(text), text).toBe(text);
    }
  });

  it("leaves headings and table rows alone", () => {
    const text = "### Queued in Approvals (0)\n| #1 | Update ad set budget | Queued in Approvals |";
    expect(stripQueuedClaims(text)).toBe(text);
  });
});

describe("renderQueueDecisionEvidence", () => {
  it("tells the writer nothing is queued when the operator didn't ask", () => {
    const text = renderQueueDecisionEvidence(brief({ mode: "analyse" }), { queue: [], labels: [], queuedRefs: [], skipped: [] });
    expect(text).toMatch(/No changes are being queued/);
    expect(text).toMatch(/Do not say/);
  });

  it("lists exactly what is and isn't queued and calls the decision final", () => {
    const text = renderQueueDecisionEvidence(brief({ queue: { requested: true, refs: [1, 2] } }), {
      queue: [],
      labels: ["#1 Scale ad set A"],
      queuedRefs: [1],
      skipped: [{ label: "#2 Trim ad set B", reason: "changed since it was shown" }],
    });
    expect(text).toContain("#1 Scale ad set A");
    expect(text).toContain("#2 Trim ad set B");
    expect(text).toContain("changed since it was shown");
    expect(text).toMatch(/final/i);
  });
});

describe("isReferencingQueue", () => {
  it("is true for refs, all, or an area picked from an earlier list", () => {
    expect(isReferencingQueue(brief({ queue: { requested: true, refs: [1] } }))).toBe(true);
    expect(isReferencingQueue(brief({ queue: { requested: true, all: true } }))).toBe(true);
    expect(isReferencingQueue(brief({ queue: { requested: true, focus: ["budget"] } }))).toBe(true);
  });

  it("is false for optimising afresh, a direct instruction, or nothing queued", () => {
    expect(isReferencingQueue(brief({ optimizationAsk: true, queue: { requested: true, focus: ["budget"] } }))).toBe(false);
    expect(isReferencingQueue(brief({ queue: { requested: true, entities: ["X"] } }))).toBe(false);
    expect(isReferencingQueue(brief({ mode: "analyse" }))).toBe(false);
  });
});
