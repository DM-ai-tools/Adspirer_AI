import { afterEach, describe, expect, it } from "vitest";
import { createPendingApproval } from "@/lib/approvals/service";
import { getDemoStore } from "@/lib/demo/store";
import { isZoneless, zonedTimeToIso } from "@/lib/meta/adset-edits";

/**
 * "End it on 30 Nov" means the end of 30 Nov where the ad account is, not the start of 30 Nov in
 * UTC (which ends the ad set a day early) or in whatever zone the server happens to be in.
 */

describe("zonedTimeToIso", () => {
  it("a date alone is the end of that day in the zone", () => {
    expect(zonedTimeToIso("2026-11-30", "Australia/Brisbane", "end")).toBe("2026-11-30T13:59:59.000Z");
    expect(zonedTimeToIso("2026-11-30", "America/New_York", "end")).toBe("2026-12-01T04:59:59.000Z");
    expect(zonedTimeToIso("2026-11-30", "UTC", "end")).toBe("2026-11-30T23:59:59.000Z");
  });

  it("a start date is the start of that day in the zone", () => {
    expect(zonedTimeToIso("2026-11-30", "Australia/Brisbane", "start")).toBe("2026-11-29T14:00:00.000Z");
  });

  it("a time with no offset is a wall-clock time in the zone", () => {
    expect(zonedTimeToIso("2026-11-30T09:30", "Australia/Brisbane", "end")).toBe("2026-11-29T23:30:00.000Z");
    expect(zonedTimeToIso("2026-11-30 09:30:15", "Australia/Brisbane", "end")).toBe("2026-11-29T23:30:15.000Z");
  });

  it("is right across a daylight-saving change", () => {
    // New York moved to summer time on 2026-03-08 (UTC-4 after, UTC-5 before).
    expect(zonedTimeToIso("2026-03-08T12:00", "America/New_York", "end")).toBe("2026-03-08T16:00:00.000Z");
    expect(zonedTimeToIso("2026-03-07T12:00", "America/New_York", "end")).toBe("2026-03-07T17:00:00.000Z");
  });

  it("rejects a zone it does not know", () => {
    expect(() => zonedTimeToIso("2026-11-30", "Not/AZone", "end")).toThrow();
  });
});

describe("isZoneless", () => {
  it("is true for a date or a time with no offset, false when the offset is stated", () => {
    for (const v of ["2026-11-30", "2026-11-30T09:30", "2026-11-30 09:30:00", "2026-11-30T09:30:00.000"]) expect(isZoneless(v), v).toBe(true);
    for (const v of ["2026-11-30T09:30:00Z", "2026-11-30T09:30:00+10:00", "2026-11-30T09:30:00+1000", "1795000000"]) expect(isZoneless(v), v).toBe(false);
  });
});

describe("a schedule change is queued in the ad account's time zone", () => {
  const CLIENT = "client_modern_dental";
  const ACCOUNT = "act_100200300";
  const ADSET = "adset_mdc_npl_2";
  const year = new Date().getUTCFullYear() + 1;
  const account = () => getDemoStore().connectedMetaAccounts.find((a) => a.client_id === CLIENT && a.meta_account_id.includes("100200300"))!;
  const original = account().timezone;
  afterEach(() => {
    account().timezone = original;
  });
  const propose = (end_time: string) =>
    createPendingApproval({ clientId: CLIENT, toolName: "update_adset_schedule", proposedArgs: { account_id: ACCOUNT, adset_id: ADSET, end_time } });

  it("a date alone becomes the end of that day where the account is", async () => {
    account().timezone = "Australia/Brisbane";
    const approval = await propose(`${year}-06-15`);
    expect(approval.proposed_args.end_time).toBe(`${year}-06-15T13:59:59.000Z`);
  });

  it("a time with no offset is read in the account's zone", async () => {
    account().timezone = "America/New_York";
    const approval = await propose(`${year}-06-15T09:00`);
    expect(approval.proposed_args.end_time).toBe(`${year}-06-15T13:00:00.000Z`);
  });

  it("a time that states its offset is taken as stated", async () => {
    account().timezone = "America/New_York";
    const approval = await propose(`${year}-06-15T10:00:00+10:00`);
    expect(approval.proposed_args.end_time).toBe(`${year}-06-15T00:00:00.000Z`);
  });

  it("a date alone is refused, not guessed, when the account's zone is not known", async () => {
    account().timezone = null;
    await expect(propose(`${year}-06-15`)).rejects.toThrow(/time zone/i);
  });

  it("a time that states its offset needs no zone", async () => {
    account().timezone = null;
    const approval = await propose(`${year}-06-15T10:00:00Z`);
    expect(approval.proposed_args.end_time).toBe(`${year}-06-15T10:00:00.000Z`);
  });
});
