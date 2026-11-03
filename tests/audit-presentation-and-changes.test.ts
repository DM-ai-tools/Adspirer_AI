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
});
