import { describe, expect, it } from "vitest";
import { feedHealth, overallMatchRate, problemFigures } from "@/lib/meta/catalog/health-figures";
import type { CatalogDiagnostic, CatalogFeed } from "@/lib/meta/catalog/types";

const diag = (
  type: string,
  severity: string,
  affectedItems: number,
  children: Array<[string, number]>,
): CatalogDiagnostic => ({
  type,
  severity,
  title: type,
  errorCode: null,
  affectedItems,
  children: children.map(([t, n]) => ({ type: t, description: t, affectedItems: n })),
});

const feed = (over: Partial<CatalogFeed> = {}): CatalogFeed => ({
  id: "f1",
  name: "Feed",
  productCount: 10,
  scheduleUrl: "https://x.example/feed.xml",
  scheduleInterval: "DAILY",
  lastUpload: { endTime: "2026-11-01T00:00:00Z", errorCount: 0, warningCount: 0 },
  ...over,
});

describe("problemFigures", () => {
  const live = [
    diag("SHOPS_VISIBILITY_ISSUES", "MUST_FIX", 130, [["PRODUCT_NOT_APPROVED", 130]]),
    diag("DA_VISIBILITY_ISSUES", "MUST_FIX", 56743, [
      ["PRODUCT_OUT_OF_STOCK", 55311],
      ["EMPTY_TITLE", 1427],
      ["image_fetch_failed", 3],
      ["da_policy_violation", 2],
    ]),
  ];

  it("sums rejected children only", () => {
    expect(problemFigures(live).rejected).toBe(132);
  });

  it("sums other must-fix children, excluding out of stock and rejected", () => {
    expect(problemFigures(live).otherProblems).toBe(1430);
  });

  it("ignores parent figures and non-must-fix children for other problems", () => {
    const f = problemFigures([
      diag("X", "OPPORTUNITY", 500, [["EMPTY_TITLE", 5]]),
      diag("Y", "MUST_FIX", 900, []),
    ]);
    expect(f).toEqual({ rejected: 0, otherProblems: 0 });
  });
});

describe("feedHealth", () => {
  it("says no feed when there are none", () => {
    expect(feedHealth([], []).value).toBe("No feed");
  });
  it("flags feed findings", () => {
    expect(feedHealth([feed()], [{ id: "feed_stale:f1" }]).value).toBe("Needs attention");
  });
  it("flags a feed that never uploaded", () => {
    expect(feedHealth([feed({ lastUpload: null })], []).value).toBe("No uploads yet");
  });
  it("flags a feed with no schedule", () => {
    expect(feedHealth([feed({ scheduleUrl: null })], []).value).toBe("Not scheduled");
  });
  it("is healthy only when every feed uploads on a schedule", () => {
    expect(feedHealth([feed()], [])).toMatchObject({ value: "Healthy", tone: "success" });
  });
});

describe("overallMatchRate", () => {
  it("is null with no events and a share otherwise", () => {
    expect(overallMatchRate([])).toBeNull();
    expect(overallMatchRate([{ matched: 90, unmatched: 10 }])).toBe(0.9);
  });
});
