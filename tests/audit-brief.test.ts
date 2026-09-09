import { describe, expect, it } from "vitest";
import {
  looksLikeAuditBriefReply,
  matchCampaignsByHints,
  parseDateRangeFromText,
  resolveAuditBrief,
} from "@/lib/agent/audit-brief";
import { detectRequestIntentWithHistory } from "@/lib/agent/task-plan";

describe("audit brief", () => {
  it("parses last N days", () => {
    const range = parseDateRangeFromText("audit last 30 days");
    expect(range?.dateLabel).toBe("last 30 days");
    expect(range?.dateStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(range?.dateStop).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("is ready when account scope + range given in one message", () => {
    const brief = resolveAuditBrief("Please audit the entire account for the last 7 days");
    expect(brief.scope).toBe("account");
    expect(brief.ready).toBe(true);
    expect(brief.missing).toEqual([]);
  });

  it("asks only for missing date range", () => {
    const brief = resolveAuditBrief("Audit the whole ad account");
    expect(brief.scope).toBe("account");
    expect(brief.missing).toEqual(["date_range"]);
    expect(brief.ready).toBe(false);
  });

  it("fills date range from a short follow-up", () => {
    const brief = resolveAuditBrief("last 30 days", [
      { role: "user", content: "Can you audit my Meta account?" },
      {
        role: "assistant",
        content: "I can run a best-practice audit — what date range?",
      },
    ]);
    expect(brief.scope).toBe("account");
    expect(brief.ready).toBe(true);
  });

  it("matches campaign hints", () => {
    const matched = matchCampaignsByHints(
      [
        { id: "1201", name: "TR AUDIT FINAL" },
        { id: "1202", name: "Other" },
      ],
      ["TR AUDIT"],
    );
    expect(matched).toHaveLength(1);
    expect(matched[0].id).toBe("1201");
  });

  it("keeps follow-up replies on audit intent", () => {
    expect(
      detectRequestIntentWithHistory("last 30 days", [
        { role: "user", content: "Please audit the account" },
        {
          role: "assistant",
          content: "What date range should I use for the audit?",
        },
      ]),
    ).toBe("audit");
    expect(looksLikeAuditBriefReply("entire account")).toBe(true);
  });
});
