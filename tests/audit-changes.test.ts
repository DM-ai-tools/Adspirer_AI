import { describe, expect, it } from "vitest";
import { evaluateCheckpoints } from "@/lib/audit/checkpoints";
import {
  demoMetaAuditSnapshot,
  entitiesToWatch,
  fetchMetaAuditSnapshot,
  normalizeChanges,
  scopeAuditSnapshot,
  type AuditChange,
  type MetaAuditSnapshot,
} from "@/lib/audit/meta-audit-data";
import { renderChangesEvidence } from "@/lib/audit/render";
import { META_AUDIT_FRAMEWORK } from "@/lib/agent/meta-audit-framework";

const change = (over: Partial<AuditChange> = {}): AuditChange => ({
  time: "2026-10-29T03:00:00.000Z",
  localDate: "2026-10-29",
  eventType: "update_ad_set_budget",
  label: "Ad set budget updated",
  actor: "Priya",
  application: null,
  objectType: "AD_SET",
  objectId: "a1",
  objectName: "Broad",
  campaignId: "c1",
  detail: null,
  ...over,
});

describe("normalizeChanges", () => {
  const context = {
    timezone: "Australia/Sydney",
    since: "2026-10-28",
    until: "2026-10-30",
    campaignOf: (type: string | null, id: string | null) => (type === "AD_SET" && id === "a1" ? "c1" : null),
  };

  it("keeps only the audited days in the account's timezone, newest first", () => {
    const rows = [
      // 13:30 UTC on the 27th is 00:30 on the 28th in Sydney (UTC+11): inside the window.
      { event_time: "2026-10-27T13:30:00+0000", event_type: "update_ad_set_run_status", object_type: "AD_SET", object_id: "a1", object_name: "Broad", actor_name: "Priya" },
      // 12:00 UTC on the 27th is 23:00 on the 27th in Sydney: before the window.
      { event_time: "2026-10-27T12:00:00+0000", event_type: "update_ad_set_budget", object_type: "AD_SET", object_id: "a1" },
      { event_time: "2026-10-29T03:00:00+0000", event_type: "update_ad_set_budget", object_type: "AD_SET", object_id: "a1" },
    ];
    const out = normalizeChanges(rows, context);
    expect(out.map((c) => c.localDate)).toEqual(["2026-10-29", "2026-10-28"]);
    expect(out[0]!.campaignId).toBe("c1");
  });

  it("keeps what Meta reports and invents nothing it doesn't", () => {
    const [c] = normalizeChanges(
      [{ event_time: "2026-10-29T03:00:00+0000", event_type: "update_ad_set_budget", object_type: "AD_SET", object_id: "zzz", extra_data: '{"old_value":2000,"new_value":3000}' }],
      context,
    );
    expect(c).toMatchObject({ actor: null, application: null, objectName: null, campaignId: null, label: null });
    expect(c!.detail).toBe('{"old_value":2000,"new_value":3000}');
  });

  it("drops rows with no usable time", () => {
    expect(normalizeChanges([{ event_type: "x" }, { event_time: "nonsense", event_type: "x" }], context)).toEqual([]);
  });
});

describe("entitiesToWatch", () => {
  it("watches the most-edited campaigns and ad sets, mapping an edited ad to its ad set", () => {
    const changes = [
      change({ objectType: "CAMPAIGN", objectId: "c1" }),
      change({ objectType: "AD", objectId: "ad9" }),
      change({ objectType: "AD", objectId: "ad9" }),
      change({ objectType: "PIXEL", objectId: "px", campaignId: null }),
    ];
    const watch = entitiesToWatch(changes, (id) => (id === "ad9" ? "a7" : null));
    expect(watch).toEqual({ campaigns: ["c1"], adSets: ["a7"] });
  });

  it("limits a campaign audit to the campaigns in scope", () => {
    const changes = [change({ objectType: "CAMPAIGN", objectId: "c1", campaignId: "c1" }), change({ objectType: "CAMPAIGN", objectId: "c2", campaignId: "c2" })];
    expect(entitiesToWatch(changes, () => null, ["c2"]).campaigns).toEqual(["c2"]);
  });
});

describe("fetching the change history", () => {
  function graphWith(activities: unknown) {
    const calls: Array<{ path: string; params: Record<string, unknown> }> = [];
    return {
      calls,
      graph: {
        get: async <T,>(path: string, params: Record<string, unknown> = {}): Promise<T> => {
          calls.push({ path, params });
          if (path === "act_1") return { name: "TR", currency: "USD", timezone_name: "UTC", account_status: 1 } as T;
          if (path === "act_1/campaigns") return { data: [{ id: "c1", name: "Lead Gen", objective: "OUTCOME_LEADS", effective_status: "ACTIVE" }] } as T;
          if (path === "act_1/adsets") return { data: [{ id: "a1", name: "Broad", campaign_id: "c1", effective_status: "ACTIVE" }] } as T;
          if (path === "act_1/activities") {
            if (activities instanceof Error) throw activities;
            return { data: activities } as T;
          }
          if (path === "act_1/insights" && params.time_increment === 1) {
            return {
              data: [
                { adset_id: "a1", campaign_id: "c1", date_start: "2026-10-28", spend: "10", impressions: "100", inline_link_click_ctr: "1", results: [{ indicator: "actions:lead", values: [{ value: "2" }] }] },
                { adset_id: "a1", campaign_id: "c1", date_start: "2026-10-29", spend: "10", impressions: "100", inline_link_click_ctr: "1", results: [{ indicator: "actions:lead", values: [{ value: "0" }] }] },
              ],
            } as T;
          }
          return { data: [] } as T;
        },
      },
    };
  }
  const range = { since: "2026-10-28", until: "2026-10-30", compare: false };

  it("reads the activity history and the day-by-day delivery of what was edited", async () => {
    const { graph, calls } = graphWith([
      { event_time: "2026-10-29T03:00:00+0000", event_type: "update_ad_set_budget", object_type: "AD_SET", object_id: "a1", object_name: "Broad", actor_name: "Priya", extra_data: '{"old_value":2000,"new_value":3000}' },
    ]);
    const snap = await fetchMetaAuditSnapshot(graph, "act_1", range);
    expect(snap.changes).toHaveLength(1);
    expect(snap.changes![0]).toMatchObject({ campaignId: "c1", actor: "Priya", localDate: "2026-10-29" });
    expect(snap.changeContext).toHaveLength(1);
    expect(snap.changeContext![0]).toMatchObject({ entityType: "ad set", id: "a1", name: "Broad" });
    expect(snap.changeContext![0]!.days.map((d) => d.date)).toEqual(["2026-10-28", "2026-10-29"]);
    expect(snap.changeContext![0]!.days[0]).toMatchObject({ spendCents: 1000, results: 2 });
    const activityCall = calls.find((c) => c.path === "act_1/activities")!;
    expect(String(activityCall.params.fields)).toContain("actor_name");
  });

  it("an empty history is a loaded list with no edits", async () => {
    const { graph } = graphWith([]);
    const snap = await fetchMetaAuditSnapshot(graph, "act_1", range);
    expect(snap.changes).toEqual([]);
    expect(snap.changeContext).toBeUndefined();
  });

  it("a history that can't be read is left unset with a warning — never an empty list", async () => {
    const { graph } = graphWith(new Error("(#200) Requires ads_management permission"));
    const snap = await fetchMetaAuditSnapshot(graph, "act_1", range);
    expect(snap.changes).toBeUndefined();
    expect(snap.warnings.some((w) => w.startsWith("Change history"))).toBe(true);
  });
});

describe("campaign scope", () => {
  it("keeps edits to the audited campaigns and tracking, and counts edits it can't place", () => {
    const base = demoMetaAuditSnapshot("act_1", "Demo", 4);
    const snap: MetaAuditSnapshot = {
      ...base,
      changes: [
        change({ campaignId: "demo_campaign_1", objectId: "as_1" }),
        change({ campaignId: "demo_campaign_2", objectId: "as_3" }),
        change({ objectType: "PIXEL", objectId: "px", campaignId: null }),
        change({ objectType: "AD", objectId: "gone", campaignId: null }),
      ],
    };
    const scoped = scopeAuditSnapshot(snap, ["demo_campaign_1"]);
    expect(scoped.changes!.map((c) => c.objectId)).toEqual(["as_1", "px"]);
    expect(scoped.changesUnresolved).toBe(1);
  });
});

describe("renderChangesEvidence", () => {
  const base = demoMetaAuditSnapshot("act_1", "Demo", 4);

  it("lists the edits with who, when and what, and the day-by-day numbers", () => {
    const text = renderChangesEvidence({
      ...base,
      changes: [change({ detail: '{"old_value":2000,"new_value":3000}' })],
      changeContext: [{ entityType: "ad set", id: "a1", name: "Broad", days: [{ date: "2026-10-28", spendCents: 1000, impressions: 100, results: 2, costPerResultCents: 500, linkCtr: 1 }] }],
    });
    expect(text).toContain("2026-10-29 03:00 UTC");
    expect(text).toContain("Priya");
    expect(text).toContain("Ad set budget updated [update_ad_set_budget]");
    expect(text).toContain('detail: {"old_value":2000,"new_value":3000}');
    expect(text).toContain('ad set "Broad" (a1)');
    expect(text).toContain("minor units");
  });

  it("says the history couldn't be read, and forbids claiming nothing changed", () => {
    const { changes: _unused, ...rest } = base;
    const text = renderChangesEvidence({ ...rest, warnings: ["Change history: (#200) permission"] });
    expect(text).toContain("could not be read");
    expect(text).toContain("Do NOT write that nothing changed");
  });

  it("only an empty, loaded list allows saying nothing was edited", () => {
    expect(renderChangesEvidence({ ...base, changes: [] })).toContain("Meta recorded no edits");
  });

  it("flags a history cut at its page cap", () => {
    expect(renderChangesEvidence({ ...base, changes: [change()], changesTruncated: true })).toContain("may be incomplete");
  });
});

describe("no generic template findings", () => {
  it("doesn't raise unused pixels, idle audiences, naming, platform split or 'no retargeting' on their own", () => {
    const snap = demoMetaAuditSnapshot("act_1", "Demo", 30);
    snap.pixels = [...snap.pixels, { id: "old", name: "Old pixel", lastFiredTime: "2020-01-01T00:00:00Z", automaticMatching: false, stats7d: null, stats28d: null }];
    snap.audiences = [{ id: "idle", name: "Idle broken", subtype: "CUSTOM", sizeLower: 10, ready: false, problem: "too small" }];
    const ids = evaluateCheckpoints(snap).checkpoints.map((c) => c.id);
    for (const generic of ["T5", "T10", "S3", "S4", "A4", "A5"]) expect(ids).not.toContain(generic);
    // An idle broken audience that no live ad set targets is not a finding.
    expect(evaluateCheckpoints(snap).checkpoints.find((c) => c.id === "A1")?.status).not.toBe("fail");
  });

  it("still fails when a live ad set targets a broken audience", () => {
    const snap = demoMetaAuditSnapshot("act_1", "Demo", 30);
    snap.audiences = snap.audiences.map((a) => (a.id === "aud_lal" ? { ...a, ready: false, problem: "too small" } : a));
    expect(evaluateCheckpoints(snap).checkpoints.find((c) => c.id === "A1")).toMatchObject({ status: "fail" });
  });

  it("flags retargeting only when it takes most of the spend", () => {
    const snap = demoMetaAuditSnapshot("act_1", "Demo", 30);
    const f1 = evaluateCheckpoints(snap).checkpoints.find((c) => c.id === "F1");
    expect(f1?.status).toBe("pass");
  });
});

describe("audit method wording", () => {
  it("teaches how to read changes and gives each one a justified / wrong-call verdict", () => {
    expect(META_AUDIT_FRAMEWORK).toContain("## Changes during the period");
    expect(META_AUDIT_FRAMEWORK).toMatch(/justified or a wrong call/i);
    expect(META_AUDIT_FRAMEWORK).toMatch(/learning phase/i);
    expect(META_AUDIT_FRAMEWORK).toMatch(/never write that nothing changed/i);
  });

  it("makes each problem live in one place, drops the What's Working section and keeps the checklist in chat only", () => {
    expect(META_AUDIT_FRAMEWORK).toMatch(/Say each thing once/);
    expect(META_AUDIT_FRAMEWORK).not.toContain("What's Working");
    expect(META_AUDIT_FRAMEWORK).toMatch(/strongest thing working/);
    expect(META_AUDIT_FRAMEWORK).toContain('"Audit checklist" is appended automatically after your report in the chat');
    expect(META_AUDIT_FRAMEWORK).toMatch(/not part of the downloaded report/);
  });
});

describe("findRepeatedFigures", () => {
  const repeating = [
    "## 1. Executive Summary",
    "Spent $103.99 with no results (34 events, 3% server-side).",
    "## 3. Tracking & Measurement",
    "$103.99 produced 0 attributed results.",
    "## 4. Active Campaigns",
    "The ad set spent $103.99.",
    "## 6. Risks & Issues",
    "| R1 | Attribution break | $103.99 spent | fix |",
    "## 8. Prioritised Recommendations",
    "Fix tracking so the $103.99 is measurable.",
    "## Audit checklist",
    "$103.99 again, which is allowed here.",
  ].join("\n");

  it("flags a figure that's carried through more than three sections, ignoring the checklist", async () => {
    const { findRepeatedFigures } = await import("@/lib/audit/repeat-check");
    const found = findRepeatedFigures(repeating);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ figure: "$103.99" });
    expect(found[0]!.sections).toHaveLength(5);
  });

  it("leaves a report that says each thing once alone", async () => {
    const { findRepeatedFigures } = await import("@/lib/audit/repeat-check");
    const once = [
      "## 1. Executive Summary",
      "The biggest leak is tracking — see R1.",
      "## 6. Risks & Issues",
      "| R1 | Attribution break | $103.99 spent, 0 results | fix |",
      "## 8. Prioritised Recommendations",
      "| 1 | Fix the pixel on the thank-you page | High | Medium | This week |",
    ].join("\n");
    expect(findRepeatedFigures(once)).toEqual([]);
  });
});

describe("ad set product set", () => {
  it("maps promoted_object.product_set_id to productSetId", async () => {
    const graph = {
      get: async <T,>(path: string): Promise<T> => {
        if (path === "act_1") return { name: "TR", currency: "USD", timezone_name: "UTC", account_status: 1 } as T;
        if (path === "act_1/adsets") {
          return {
            data: [
              { id: "a1", name: "Catalogue", campaign_id: "c1", effective_status: "ACTIVE", promoted_object: { product_set_id: "1290781623112463" } },
              { id: "a2", name: "Other", campaign_id: "c1", effective_status: "ACTIVE", promoted_object: { pixel_id: "9" } },
            ],
          } as T;
        }
        return { data: [] } as T;
      },
    };
    const snap = await fetchMetaAuditSnapshot(graph, "act_1", { since: "2026-10-28", until: "2026-10-30", compare: false });
    expect(snap.adSets.find((a) => a.id === "a1")!.productSetId).toBe("1290781623112463");
    expect(snap.adSets.find((a) => a.id === "a2")!.productSetId).toBeUndefined();
  });
});
