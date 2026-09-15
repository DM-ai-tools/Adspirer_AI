import { describe, expect, it } from "vitest";
import {
  applyCompetitorUrlsFromDocuments,
  looksLikeAuditBriefReply,
  matchCampaignsByHints,
  parseDateRangeFromText,
  resolveAuditBrief,
} from "@/lib/agent/audit-brief";
import { detectRequestIntentWithHistory } from "@/lib/agent/task-plan";
import {
  extractHttpUrls,
  isCompetitorLandingSkip,
} from "@/lib/landing/urls";

describe("audit brief", () => {
  it("parses last N days", () => {
    const range = parseDateRangeFromText("audit last 30 days");
    expect(range?.dateLabel).toBe("last 30 days");
    expect(range?.dateStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(range?.dateStop).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("is ready with scope + range without competitor LP choice", () => {
    const brief = resolveAuditBrief(
      "Please audit the entire account for the last 7 days",
    );
    expect(brief.scope).toBe("account");
    expect(brief.missing).toEqual([]);
    expect(brief.ready).toBe(true);
    expect(brief.competitorLanding).toBe("unset");
  });

  it("is ready when account scope + range + skip competitors", () => {
    const brief = resolveAuditBrief(
      "Please audit the entire account for the last 7 days. No competitor landing pages.",
    );
    expect(brief.scope).toBe("account");
    expect(brief.competitorLanding).toBe("skip");
    expect(brief.ready).toBe(true);
    expect(brief.missing).toEqual([]);
  });

  it("is ready when competitor URLs are pasted", () => {
    const brief = resolveAuditBrief(
      "Audit entire account last 30 days. Compare https://competitor.example/offer and https://rival.test/lp",
    );
    expect(brief.ready).toBe(true);
    expect(brief.competitorLanding).toBe("provided");
    expect(brief.competitorUrls).toHaveLength(2);
  });

  it("asks only for missing date range (competitor LP optional)", () => {
    const brief = resolveAuditBrief("Audit the whole ad account");
    expect(brief.scope).toBe("account");
    expect(brief.missing).toEqual(["date_range"]);
    expect(brief.ready).toBe(false);
  });

  it("fills date range from follow-ups and is ready without competitor skip", () => {
    const withDates = resolveAuditBrief("last 30 days", [
      { role: "user", content: "Can you audit my Meta account?" },
      {
        role: "assistant",
        content: "I can run a best-practice audit — what date range?",
      },
    ]);
    expect(withDates.scope).toBe("account");
    expect(withDates.ready).toBe(true);
    expect(withDates.missing).toEqual([]);

    const skipped = resolveAuditBrief("no competitor pages", [
      { role: "user", content: "Can you audit my Meta account?" },
      {
        role: "assistant",
        content: "What date range and competitor landing pages?",
      },
      { role: "user", content: "last 30 days" },
    ]);
    expect(skipped.ready).toBe(true);
    expect(skipped.competitorLanding).toBe("skip");
  });

  it("merges competitor URLs from uploaded spreadsheet text", () => {
    const base = resolveAuditBrief(
      "Audit entire account last 7 days. Skip competitors for now.",
    );
    // Skip first, then documents can still upgrade to provided if needed —
    // for upload-after-ask we start unset:
    const unset = resolveAuditBrief("Audit entire account last 7 days");
    const merged = applyCompetitorUrlsFromDocuments(unset, [
      "## Sheet: Competitors\nname,url\nAcme,https://acme.test/landing\nBeta,https://beta.test/ads",
    ]);
    expect(merged.competitorLanding).toBe("provided");
    expect(merged.competitorUrls).toEqual([
      "https://acme.test/landing",
      "https://beta.test/ads",
    ]);
    expect(merged.ready).toBe(true);
    expect(base.competitorLanding).toBe("skip");
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
    expect(
      detectRequestIntentWithHistory("no", [
        { role: "user", content: "Please audit the account last 7 days" },
        {
          role: "assistant",
          content:
            "Do you have competitor landing page URLs to compare for the audit?",
        },
      ]),
    ).toBe("audit");
    expect(looksLikeAuditBriefReply("entire account")).toBe(true);
    expect(looksLikeAuditBriefReply("no")).toBe(true);
    expect(isCompetitorLandingSkip("skip competitor LPs")).toBe(true);
    expect(extractHttpUrls("see https://x.test/a and https://x.test/a")).toEqual([
      "https://x.test/a",
    ]);
  });
});
