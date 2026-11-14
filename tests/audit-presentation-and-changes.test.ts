import { describe, expect, it } from "vitest";
import { parseMarkdownToBlocks } from "@/lib/reports/parse-markdown";
import { presentBlocks } from "@/lib/reports/present";
import { META_AUDIT_FRAMEWORK } from "@/lib/agent/meta-audit-framework";
import { demoMetaAuditSnapshot, type AuditChange } from "@/lib/audit/meta-audit-data";
import { renderChangesEvidence } from "@/lib/audit/render";

const RISKS = [
  "| Severity | Issue | Evidence | Fix | Spend at stake |",
  "|---|---|---|---|---|",
  "| Critical | R1: 100% of live ad sets are learning limited | All 6 live ad sets are learning limited; daily budgets of $6-$24 give about 1 purchase a week per ad set against the ~50 a week needed | Consolidate the 5 active campaigns into 2-3 and raise budgets in 20-30% steps | AUD $5,015 |",
].join("\n");

describe("exports: text-heavy tables become cards", () => {
  it("turns the risk table into a heading and labelled bullets", () => {
    const blocks = presentBlocks(parseMarkdownToBlocks(RISKS));
    expect(blocks.some((b) => b.type === "table")).toBe(false);
    const heading = blocks.find((b) => b.type === "heading");
    expect(heading && heading.type === "heading" && heading.text).toBe("Critical · R1: 100% of live ad sets are learning limited");
    const list = blocks.find((b) => b.type === "list");
    const labels = list && list.type === "list" ? list.items.map((item) => item[0]!.text) : [];
    expect(labels).toEqual(["Evidence:", "Fix:", "Spend at stake:"]);
  });

  it("keeps a table of numbers as a table", () => {
    const md = ["| Campaign | Status | Spend | Results | CPR |", "|---|---|---|---|---|", "| Sofas | Active | $1,200 | 48 | $25 |"].join("\n");
    expect(presentBlocks(parseMarkdownToBlocks(md)).some((b) => b.type === "table")).toBe(true);
  });
});

describe("audit method", () => {
  it("asks for bullets, card layouts and a verdict per change", () => {
    expect(META_AUDIT_FRAMEWORK).toContain("Points, not paragraphs");
    expect(META_AUDIT_FRAMEWORK).toContain("Never put sentences in table cells");
    expect(META_AUDIT_FRAMEWORK).toContain("✅ Justified");
    expect(META_AUDIT_FRAMEWORK).toContain("❌ Wrong call");
    expect(META_AUDIT_FRAMEWORK).not.toContain("table: Severity | Issue");
  });
});

describe("change evidence", () => {
  const change = (over: Partial<AuditChange>): AuditChange => ({
    time: "2026-10-14T05:00:00Z",
    localDate: "2026-10-14",
    eventType: "update_ad_set_budget",
    label: "Budget changed",
    actor: "Pratham Panchal",
    application: null,
    objectType: "AD_SET",
    objectId: "as_1",
    objectName: "Dining",
    campaignId: "c1",
    detail: null,
    ...over,
  });
  const day = (date: string, spend: number, results: number | null) => ({
    date,
    spendCents: spend,
    impressions: 1000,
    results,
    costPerResultCents: results ? Math.round(spend / results) : null,
    linkCtr: 1,
  });

  it("shows schedule, and the numbers before, on and after each edit", () => {
    const snap = {
      ...demoMetaAuditSnapshot("act_1", "Shop", 30),
      changes: [change({})],
      changeContext: [
        {
          entityType: "ad set" as const,
          id: "as_1",
          name: "Dining",
          status: "ACTIVE",
          startDate: "2026-09-01",
          endDate: null,
          days: [
            day("2026-10-11", 4_000, 4),
            day("2026-10-12", 4_000, 4),
            day("2026-10-13", 4_000, 4),
            day("2026-10-14", 9_000, 2),
            day("2026-10-15", 9_000, 1),
          ],
        },
      ],
    };
    const text = renderChangesEvidence(snap);
    expect(text).toContain('ad set "Dining" (as_1) · status ACTIVE · scheduled 2026-09-01 → no end date set');
    const edit = text.split("\n").find((l) => l.includes("Edit on 2026-10-14"))!;
    expect(edit).toContain("Budget changed; Pratham Panchal");
    expect(edit).toContain("before: 3 days, spend $40.00/day, 12 results ($10.00/result)");
    expect(edit).toContain("day of: 1 day, spend $90.00/day, 2 results ($45.00/result)");
    expect(edit).toContain("after: 1 day, spend $90.00/day, 1 results");
  });

  // 14 days either side of a budget edit on 2026-10-14: the ad set doubles spend at the same cost per result,
  // while the rest of the account's cost per result rises 50%.
  const span = (from: string, n: number, f: (i: number) => { spend: number; results: number }) =>
    Array.from({ length: n }, (_, i) => {
      const date = new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
      const { spend, results } = f(i);
      return day(date, spend, results);
    });
  const adSetDays = [
    ...span("2026-10-07", 7, () => ({ spend: 10_000, results: 10 })),
    ...span("2026-10-14", 8, () => ({ spend: 20_000, results: 20 })),
  ];
  const accountDays = [
    ...span("2026-10-07", 7, () => ({ spend: 30_000, results: 30 })),
    ...span("2026-10-14", 8, () => ({ spend: 30_000, results: 20 })),
  ];
  const withContext = (since: string, until: string, ctx = adSetDays) => ({
    ...demoMetaAuditSnapshot("act_1", "Shop", 30),
    period: { days: 30, since, until },
    changes: [change({})],
    changeContext: [
      { entityType: "ad set" as const, id: "as_1", name: "Dining", status: "ACTIVE", startDate: null, endDate: null, days: ctx },
      { entityType: "account" as const, id: "act_1", name: "Shop", days: accountDays },
    ],
  });

  it("compares 7 days either side per day, past learning, and against the rest of the account", () => {
    const lines = renderChangesEvidence(withContext("2026-10-01", "2026-10-31")).split("\n");
    const at = lines.findIndex((l) => l.includes("Edit on 2026-10-14"));
    expect(lines[at]).toContain("before: 7 days, spend $100.00/day, 70 results ($10.00/result)");
    expect(lines[at]).toContain("after: 7 days, spend $200.00/day, 140 results ($10.00/result)");
    expect(lines[at + 1]).toBe("    - Change: spend/day +100%, results/day +100%, cost per result 0%, CTR 0%");
    expect(lines[at + 2]).toContain("After, days 4–7: 4 days");
    // Rest of account: $200/day for 20 results before → $100/day for 0 results after.
    expect(lines[at + 3]).toContain("Rest of account, same days: spend/day −50%, results/day −100%");
    // The account has no edits of its own, so it is only a baseline, not its own block.
    expect(lines.some((l) => l.startsWith("- whole ad account"))).toBe(false);
  });

  it("uses days outside the audited period for an edit near its start, but day-by-day shows only the period", () => {
    const text = renderChangesEvidence(withContext("2026-10-14", "2026-10-20"));
    expect(text).toContain("before: 7 days, spend $100.00/day");
    expect(text).toContain("may reach up to 7 days outside the audited period");
    const dayByDay = text.split("\n").find((l) => l.includes("Day by day (audited period)"))!;
    expect(dayByDay).not.toContain("10-13");
    expect(dayByDay).toContain("10-14");
  });

  it("cautions on thin results, short windows and nearby edits", () => {
    const thin = [day("2026-10-12", 1_000, 1), day("2026-10-13", 1_000, 1), day("2026-10-14", 1_000, 1), day("2026-10-15", 1_000, 1)];
    const snap = withContext("2026-10-01", "2026-10-31", thin);
    snap.changes = [change({}), change({ localDate: "2026-10-15", time: "2026-10-15T05:00:00Z" })];
    const caution = renderChangesEvidence(snap).split("\n").find((l) => l.includes("Caution") && l.includes("2026-10-15"))!;
    expect(caution).toContain("other edits on this ad set or its ads on 2026-10-15");
    expect(caution).toContain("only 2 of 7 days before");
    expect(caution).toContain("under 20 results in a window");
  });
});
