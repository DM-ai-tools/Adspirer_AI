import { describe, expect, it } from "vitest";
import { endOnLastWholeDay } from "@/lib/comparison/windows-end";

const TODAY = "2026-11-17";

describe("endOnLastWholeDay", () => {
  it("moves a named 'last 30 days vs previous 30 days' pair back one day, keeping them equal and touching", () => {
    const out = endOnLastWholeDay(
      { since: "2026-10-19", until: "2026-11-17" },
      { since: "2026-09-19", until: "2026-10-18" },
      TODAY,
    );
    expect(out).toEqual({
      current: { since: "2026-10-18", until: "2026-11-16" },
      previous: { since: "2026-09-18", until: "2026-10-17" },
    });
  });

  it("pulls only the current end back when the previous window is not right before it", () => {
    const out = endOnLastWholeDay(
      { since: "2026-11-01", until: "2026-11-17" },
      { since: "2026-10-01", until: "2026-10-17" },
      TODAY,
    );
    expect(out.current).toEqual({ since: "2026-11-01", until: "2026-11-16" });
    expect(out.previous).toEqual({ since: "2026-10-01", until: "2026-10-17" });
  });

  it("keeps calendar weeks aligned: 'this week vs last week' only trims today", () => {
    // Tue 17 Nov: this week Mon 16–Tue 17, last week Mon 9–Sun 15.
    const out = endOnLastWholeDay({ since: "2026-11-16", until: "2026-11-17" }, { since: "2026-11-09", until: "2026-11-15" }, TODAY);
    expect(out.current).toEqual({ since: "2026-11-16", until: "2026-11-16" });
    expect(out.previous).toEqual({ since: "2026-11-09", until: "2026-11-15" });
  });

  it("keeps calendar months aligned: 'this month vs last month' only trims today", () => {
    const out = endOnLastWholeDay({ since: "2026-11-01", until: "2026-11-17" }, { since: "2026-10-01", until: "2026-10-31" }, TODAY);
    expect(out.current).toEqual({ since: "2026-11-01", until: "2026-11-16" });
    expect(out.previous).toEqual({ since: "2026-10-01", until: "2026-10-31" });
  });

  it("pulls the current end back when there is no named previous window", () => {
    expect(endOnLastWholeDay({ since: "2026-11-03", until: "2026-11-17" }, null, TODAY).current).toEqual({
      since: "2026-11-03",
      until: "2026-11-16",
    });
  });

  it("leaves windows that already end before today alone", () => {
    const current = { since: "2026-10-01", until: "2026-10-31" };
    const previous = { since: "2026-09-01", until: "2026-09-30" };
    expect(endOnLastWholeDay(current, previous, TODAY)).toEqual({ current, previous });
  });

  it("turns a today-only window into yesterday", () => {
    expect(endOnLastWholeDay({ since: TODAY, until: TODAY }, null, TODAY).current).toEqual({
      since: "2026-11-16",
      until: "2026-11-16",
    });
  });
});
