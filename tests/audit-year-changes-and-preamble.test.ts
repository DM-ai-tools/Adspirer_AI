import { describe, expect, it } from "vitest";
import { changeWindows, fetchActivityHistory, fetchMetaAuditSnapshot } from "@/lib/audit/meta-audit-data";
import { renderChangesEvidence } from "@/lib/audit/render";
import { prepareExportMarkdown, stripAuditPreamble } from "@/lib/reports/prepare-export";
import { META_AUDIT_FRAMEWORK } from "@/lib/agent/meta-audit-framework";
import { parseDateRangeFromText } from "@/lib/agent/audit-brief";

describe("change history for a long audit", () => {
  it("cuts a year into consecutive windows of at most 31 days with no gap", () => {
    const windows = changeWindows("2025-11-13", "2026-11-12");
    expect(windows[0]!.since).toBe("2025-11-13");
    expect(windows[windows.length - 1]!.until).toBe("2026-11-12");
    expect(windows.length).toBe(12);
    for (let i = 1; i < windows.length; i++) {
      const prevEnd = Date.parse(`${windows[i - 1]!.until}T00:00:00Z`);
      expect(Date.parse(`${windows[i]!.since}T00:00:00Z`) - prevEnd).toBe(86_400_000);
    }
  });

  it("a short period is one window", () => {
    expect(changeWindows("2026-10-28", "2026-10-30")).toEqual([{ since: "2026-10-28", until: "2026-10-30" }]);
  });

  it("reads every window, so older months aren't lost to the newest edits", async () => {
    const asked: Array<{ since: number; until: number }> = [];
    const graph = {
      get: async <T,>(_path: string, params: Record<string, unknown> = {}): Promise<T> => {
        asked.push({ since: Number(params.since), until: Number(params.until) });
        // One edit in the middle of each window asked about.
        const t = new Date(((Number(params.since) + Number(params.until)) / 2) * 1000).toISOString();
        return { data: [{ event_time: t, event_type: "update_ad_set_budget", object_id: "a1", object_type: "AD_SET" }] } as T;
      },
    };
    const warnings: string[] = [];
    const result = await fetchActivityHistory(graph, "act_1", "2025-11-13", "2026-11-12", warnings);
    expect(asked).toHaveLength(12);
    expect(result!.rows).toHaveLength(12);
    expect(result!.truncated).toBe(false);
    expect(warnings).toEqual([]);
  });

  it("keeps what it could read and says it may be incomplete when one window fails", async () => {
    let n = 0;
    const graph = {
      get: async <T,>(): Promise<T> => {
        n += 1;
        if (n === 3) throw new Error("rate limited");
        return { data: [{ event_time: `2026-0${(n % 9) + 1}-10T03:00:00+0000`, event_type: "update_campaign_status", object_id: `c${n}` }] } as T;
      },
    };
    const warnings: string[] = [];
    const result = await fetchActivityHistory(graph, "act_1", "2025-11-13", "2026-11-12", warnings);
    expect(result!.rows.length).toBe(11);
    expect(result!.truncated).toBe(true);
    expect(warnings[0]).toContain("1 of 12 windows could not be read");
  });

  it("is unreadable only when no window could be read", async () => {
    const graph = { get: async (): Promise<never> => { throw new Error("no permission"); } };
    const warnings: string[] = [];
    expect(await fetchActivityHistory(graph, "act_1", "2025-11-13", "2026-11-12", warnings)).toBeNull();
    expect(warnings[0]).toContain("no permission");
  });

  it("a year-long snapshot carries edits from its early months too", async () => {
    const graph = {
      get: async <T,>(path: string, params: Record<string, unknown> = {}): Promise<T> => {
        if (path === "act_1") return { name: "TR", currency: "USD", timezone_name: "UTC", account_status: 1 } as T;
        if (path === "act_1/activities") {
          const since = Number(params.since);
          const until = Number(params.until);
          const t = new Date(((since + until) / 2) * 1000).toISOString();
          return { data: [{ event_time: t, event_type: "update_campaign_budget", object_type: "CAMPAIGN", object_id: "c1", object_name: "Sales" }] } as T;
        }
        return { data: [] } as T;
      },
    };
    const snap = await fetchMetaAuditSnapshot(graph, "act_1", { since: "2025-11-13", until: "2026-11-12", compare: false });
    expect(snap.changes!.length).toBe(12);
    expect(snap.changes!.some((c) => c.localDate < "2026-01-01")).toBe(true);
    const evidence = renderChangesEvidence(snap);
    expect(evidence).toContain("across the whole audited period (2025-11-13 → 2026-11-12)");
    expect(evidence).toContain("Edits by month:");
    expect(evidence).toContain("Count by kind:");
  });
});

describe("year periods are understood", () => {
  it("is not asked about again when the operator says a year", () => {
    for (const text of ["audit the last year", "audit for one year", "audit the past 1 year", "audit for 12 months"]) {
      const range = parseDateRangeFromText(text);
      expect(range, text).not.toBeNull();
      expect(range!.dateStop).toBeTruthy();
    }
  });
});

describe("an audit starts at its title", () => {
  const narration = [
    "I need to pull the full 12-month spend data before writing the audit. Let me fetch that now.",
    "",
    "Now let me pull the remaining campaigns not returned in the first call.",
    "",
    "I now have everything needed. Here is the full audit.",
    "",
  ].join("\n");
  const report = "# Meta Ads Account Audit — Bulk Buys\n\n## 1. Executive Summary\n\n- Score 54/100\n";

  it("drops narration before the title", () => {
    expect(stripAuditPreamble(narration + report)).toBe(report);
  });

  it("leaves a report that already starts at its title, and text without a title, alone", () => {
    expect(stripAuditPreamble(report)).toBe(report);
    expect(stripAuditPreamble("Spend was $10 last week.")).toBe("Spend was $10 last week.");
  });

  it("keeps the narration out of the downloads", () => {
    const md = prepareExportMarkdown(narration + report);
    expect(md).not.toMatch(/pull the full|Here is the full audit|everything needed/i);
    expect(md.startsWith("# Meta Ads Account Audit — Bulk Buys")).toBe(true);
  });
});

describe("the audit method", () => {
  it("asks for ordered Next Steps cards, not one sentence", () => {
    expect(META_AUDIT_FRAMEWORK).toMatch(/Next Steps\*\* — the order to work in/);
    expect(META_AUDIT_FRAMEWORK).toMatch(/3–5 numbered steps/);
    expect(META_AUDIT_FRAMEWORK).toMatch(/\*\*Done when:\*\*/);
    expect(META_AUDIT_FRAMEWORK).not.toMatch(/Next Steps\*\* — one sentence/);
  });

  it("ties the changes section to the period in the evidence header", () => {
    expect(META_AUDIT_FRAMEWORK).toMatch(/Changes made <from> → <to>/);
    expect(META_AUDIT_FRAMEWORK).toMatch(/never describe the window as a single day/);
  });
});

describe("a risk whose fix is a list of steps", () => {
  it("shows the steps as the Fix, not a dash with loose bullets", async () => {
    const { parseMarkdownToBlocks } = await import("@/lib/reports/parse-markdown");
    const { presentBlocks } = await import("@/lib/reports/present");
    const md = [
      "### R2 · Critical — $678 wasted on an ad set with no country targeting",
      "- **Evidence:** It spent $678.29 at ROAS 0.23×.",
      "- **Fix:**",
      "- Do not reactivate this ad set without setting countries = AU",
      "- Audit all other active ad sets to confirm geo-targeting is set",
      "- **Spend at stake:** $678",
    ].join("\n");
    const card = presentBlocks(parseMarkdownToBlocks(md)).find((b) => b.type === "card");
    expect(card && card.type === "card").toBe(true);
    if (card?.type !== "card") return;
    const fix = card.fields.find((f) => f.label === "Fix")!;
    const text = fix.value.map((v) => v.text).join("");
    expect(text).toContain("Do not reactivate this ad set");
    expect(text).toContain("Audit all other active ad sets");
    expect(text).not.toBe("—");
    expect(card.fields.map((f) => f.label)).toEqual(["Evidence", "Fix", "Spend at stake"]);
    expect(card.notes).toEqual([]);
  });
});
