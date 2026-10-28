import { describe, expect, it } from "vitest";
import { metaTimeMs, planScheduleChange, type ScheduleCurrent } from "@/lib/meta/adset-edits";

const NOW = Date.parse("2026-10-28T10:00:00Z");
const started = {
  status: "ACTIVE",
  start_time: "2026-10-01T00:00:00+0000",
  end_time: "2026-11-15T00:00:00+0000",
  lifetime_budget: false,
};
const plan = (current: Partial<ScheduleCurrent>, change: Parameters<typeof planScheduleChange>[1]) =>
  planScheduleChange({ ...started, ...current }, change, NOW);

describe("metaTimeMs", () => {
  it("reads the formats Meta returns and accepts", () => {
    const iso = Date.parse("2026-11-15T00:00:00Z");
    expect(metaTimeMs("2026-11-15T00:00:00+0000")).toBe(iso);
    expect(metaTimeMs("2026-11-15T00:00:00Z")).toBe(iso);
    expect(metaTimeMs("2026-11-15T05:30:00+05:30")).toBe(iso);
    expect(metaTimeMs(iso / 1000)).toBe(iso);
  });

  it("treats empty, zero and junk as no time", () => {
    for (const v of [null, undefined, "", "0", 0, "not a date", {}]) expect(metaTimeMs(v), String(v)).toBeNull();
  });
});

describe("planScheduleChange", () => {
  it("moves the end date later", () => {
    const out = plan({}, { end_time: "2026-12-01T00:00:00Z" });
    expect(out.body).toEqual({ end_time: "2026-12-01T00:00:00.000Z" });
    expect(out.direction).toBe("later");
  });

  it("moves the end date earlier", () => {
    expect(plan({}, { end_time: "2026-11-01T00:00:00Z" }).direction).toBe("earlier");
  });

  it("putting an end date on a continuous ad set ends it sooner", () => {
    const out = plan({ end_time: null }, { end_time: "2026-11-20T00:00:00Z" });
    expect(out.direction).toBe("earlier");
  });

  it("refuses an end date it already has", () => {
    expect(() => plan({}, { end_time: "2026-11-15T00:00:00Z" })).toThrow(/already ends/);
  });

  it("refuses an end date in the past, and says nothing changed", () => {
    expect(() => plan({}, { end_time: "2026-10-27T00:00:00Z" })).toThrow(/in the past.*Nothing was changed/);
  });

  it("clears the end date with end_time 0", () => {
    const out = plan({}, { clear_end_time: true });
    expect(out.body).toEqual({ end_time: "0" });
    expect(out.direction).toBe("cleared");
  });

  it("refuses to clear what is already continuous", () => {
    expect(() => plan({ end_time: null }, { clear_end_time: true })).toThrow(/already runs continuously/);
  });

  it("refuses to clear the end date of a lifetime budget", () => {
    expect(() => plan({ lifetime_budget: true }, { clear_end_time: true })).toThrow(/lifetime budget.*Nothing was changed/);
  });

  it("refuses to move the start of an ad set that has started", () => {
    expect(() => plan({}, { start_time: "2026-11-01T00:00:00Z" })).toThrow(/already started.*Nothing was changed/);
  });

  it("moves the start of an ad set that has not started", () => {
    const out = plan({ start_time: "2026-11-05T00:00:00+0000", end_time: null }, { start_time: "2026-11-03T00:00:00Z" });
    expect(out.body).toEqual({ start_time: "2026-11-03T00:00:00.000Z" });
  });

  it("refuses an end date before the start", () => {
    expect(() =>
      plan({ start_time: "2026-11-05T00:00:00+0000", end_time: null }, { end_time: "2026-11-01T00:00:00Z" }),
    ).toThrow(/after the start/);
  });

  it("a daily budget needs more than 24 hours between start and end", () => {
    expect(() =>
      plan({ start_time: "2026-11-05T00:00:00+0000", end_time: null }, { end_time: "2026-11-05T12:00:00Z" }),
    ).toThrow(/more than 24 hours/);
    expect(
      plan({ start_time: "2026-11-05T00:00:00+0000", end_time: null, lifetime_budget: true }, { end_time: "2026-11-05T12:00:00Z" }).body,
    ).toEqual({ end_time: "2026-11-05T12:00:00.000Z" });
  });

  it("refuses a request that asks for nothing", () => {
    expect(() => plan({}, {})).toThrow(/Provide end_time/);
  });

  it("refuses an end date and a cleared end date together", () => {
    expect(() => plan({}, { end_time: "2026-12-01T00:00:00Z", clear_end_time: true })).toThrow(/not both/);
  });
});
