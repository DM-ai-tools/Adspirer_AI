import { describe, expect, it } from "vitest";
import { parseNaturalDateRange } from "@/lib/agent/natural-dates";
import { parseDateRangeFromText, resolveAuditBrief } from "@/lib/agent/audit-brief";
import { detectRequestIntentWithHistory } from "@/lib/agent/task-plan";
import { splitMarkdownTableRow, escapeTableCell } from "@/lib/reports/table-row";
import { parseMarkdownToBlocks } from "@/lib/reports/parse-markdown";

const NOW = new Date("2026-10-09T08:00:00Z");
const range = (text: string) => {
  const r = parseNaturalDateRange(text, NOW);
  return r ? `${r.dateStart}..${r.dateStop}` : null;
};

describe("parseNaturalDateRange", () => {
  it.each([
    ["1st sept to 15th sept", "2026-09-01..2026-09-15"],
    ["1 Sep to 15 Sep", "2026-09-01..2026-09-15"],
    ["sept 1 - sept 15", "2026-09-01..2026-09-15"],
    ["Sep 1–15, 2026", "2026-09-01..2026-09-15"],
    ["1-15 september", "2026-09-01..2026-09-15"],
    ["from 1st September till 15th September 2026", "2026-09-01..2026-09-15"],
    ["01/09/2026 to 15/09/2026", "2026-09-01..2026-09-15"],
    ["9/1/2026 to 9/15/2026", "2026-09-01..2026-09-15"], // month-first only when day-first is impossible
    ["15 dec to 10 jan", "2025-12-15..2026-01-10"],
    ["September 2026", "2026-09-01..2026-09-30"],
    ["for august", "2026-08-01..2026-08-31"],
    ["last month", "2026-09-01..2026-09-30"],
    ["1 Oct to 31 Oct", "2026-10-01..2026-10-09"], // future days clamped to today
    ["november", "2025-11-01..2025-11-30"], // a month that hasn't happened yet this year → last year's
  ])("%s → %s", (text, expected) => {
    expect(range(text)).toBe(expected);
  });

  it("ignores text without dates and the verb 'may'", () => {
    expect(range("may I see the spend please")).toBeNull();
    expect(range("audit the account")).toBeNull();
  });

  it("is used by the audit brief", () => {
    expect(parseDateRangeFromText("1st sept to 15th sept")).not.toBeNull();
  });
});

describe("audit follow-up routing", () => {
  const history = [
    { role: "user" as const, content: "Audit the account and summarize spend, delivery, and risks" },
    {
      role: "assistant" as const,
      content: "Before I run the full audit, I just need one thing:\n\n**What date range should I cover?**",
    },
  ];

  it("treats a natural date reply as the audit brief", () => {
    expect(detectRequestIntentWithHistory("1st sept to 15th sept", history)).toBe("audit");
    const brief = resolveAuditBrief("1st sept to 15th sept", history);
    expect(brief.missing).not.toContain("date_range");
    expect(brief.dateStart).toMatch(/-09-01$/);
  });

  it("keeps an unreadable reply on the audit path so the question is asked again", () => {
    expect(detectRequestIntentWithHistory("whenever is fine", history)).toBe("audit");
    expect(resolveAuditBrief("whenever is fine", history).missing).toContain("date_range");
  });
});

describe("markdown table rows", () => {
  it("honours escaped pipes in cells", () => {
    expect(
      splitMarkdownTableRow("| Critical | TR \\| Lead Gen Traffic Radius \\| Sep 2026 | $30/day |"),
    ).toEqual(["Critical", "TR | Lead Gen Traffic Radius | Sep 2026", "$30/day"]);
  });

  it("round-trips escaped cells through the export parser", () => {
    const name = "TR | Lead Gen Traffic Radius | Sep 2026";
    const md = [
      "| Severity | Issue | Evidence |",
      "| --- | --- | --- |",
      `| Critical | Campaign has no live ad sets | ${escapeTableCell(name)} is ACTIVE |`,
    ].join("\n");
    const table = parseMarkdownToBlocks(md).find((b) => b.type === "table");
    expect(table && table.type === "table" ? table.rows[0] : null).toEqual([
      "Critical",
      "Campaign has no live ad sets",
      `${name} is ACTIVE`,
    ]);
  });
});
