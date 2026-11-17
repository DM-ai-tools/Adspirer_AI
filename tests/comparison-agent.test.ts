import { afterEach, describe, expect, it, vi } from "vitest";
import { gatherDiagnoseEvidence, runAdspirerAgent } from "@/lib/agent/adspirer-agent";
import { createTask } from "@/lib/agent/task-runner";
import { resolveProvider } from "@/lib/adspirer/client";
import { resetDemoStore } from "@/lib/demo/store";
import { classify, listClassifiedTools } from "@/lib/tools/policy";
import { exportDocx, exportMarkdown, exportPdf, exportReportPayload } from "@/lib/reports/export";
import { inferExportTitle, prepareExportMarkdown } from "@/lib/reports/prepare-export";
import { looksLikeFullAuditMarkdown } from "@/lib/report/from-markdown";
import { extractText, getDocumentProxy } from "unpdf";
import JSZip from "jszip";

const EXECUTE_TOOLS = new Set(listClassifiedTools().filter((t) => t.safety === "execute").map((t) => t.name));

afterEach(() => {
  vi.restoreAllMocks();
  resetDemoStore();
});

const REQUEST = "compare last 14 days with the 14 before";

describe("comparison turn in DEMO_MODE", () => {
  it("gathers the comparison evidence and the framework, read-only", async () => {
    const gathered = await gatherDiagnoseEvidence({
      clientId: "client_modern_dental",
      request: REQUEST,
      intent: "comparison",
    });
    expect(gathered.evidence).toContain("### Comparison evidence —");
    expect(gathered.evidence).toContain("### Comparison framework");
    expect(gathered.evidence).toContain("## 12. Findings and implications");
    expect(gathered.comparisonBuilt).toBe(true);
    const names = gathered.toolCalls.map((c) => c.name);
    expect(names).toContain("comparison_report");
    expect(names.filter((n) => EXECUTE_TOOLS.has(n))).toEqual([]);
    expect(classify("comparison_report")).toBe("diagnose");
    expect(gathered.offered ?? []).toEqual([]);
  });

  it("asks the snapshot for both windows with the comparison detail", async () => {
    const provider = await resolveProvider();
    const spy = vi.spyOn(provider, "getAuditSnapshot");
    await gatherDiagnoseEvidence({ clientId: "client_modern_dental", request: REQUEST, intent: "comparison" });
    expect(spy).toHaveBeenCalledTimes(1);
    const options = spy.mock.calls[0]![1]!;
    expect(options.compare).toBe(true);
    expect(options.comparisonDetail).toBe(true);
    expect(options.days).toBe(14);
    expect(options.campaignIds).toBeUndefined();
  });

  it("defaults to the last 14 days against the equal window before when no period is named", async () => {
    const provider = await resolveProvider();
    const spy = vi.spyOn(provider, "getAuditSnapshot");
    await gatherDiagnoseEvidence({
      clientId: "client_modern_dental",
      request: "what changed in the account",
      intent: "comparison",
    });
    const options = spy.mock.calls[0]![1]!;
    expect(options.days).toBe(14);
    expect(options.comparisonDetail).toBe(true);
    expect(options.compareSince).toBeUndefined();
    expect(options.compareUntil).toBeUndefined();
  });

  it("passes a named comparison range through", async () => {
    const provider = await resolveProvider();
    const spy = vi.spyOn(provider, "getAuditSnapshot");
    await gatherDiagnoseEvidence({
      clientId: "client_modern_dental",
      request: "compare Oct 19-20 vs Oct 17-18",
      intent: "comparison",
    });
    const options = spy.mock.calls[0]![1]!;
    expect(options.compareSince).toBeTruthy();
    expect(options.compareUntil).toBeTruthy();
    expect(options.days).toBe(2);
  });

  it("an audit that asks to compare does not request the comparison detail", async () => {
    const provider = await resolveProvider();
    const spy = vi.spyOn(provider, "getAuditSnapshot");
    await gatherDiagnoseEvidence({
      clientId: "client_modern_dental",
      request: "audit the entire account for last 14 days and compare with the previous period",
      intent: "audit",
    });
    expect(spy).toHaveBeenCalled();
    for (const call of spy.mock.calls) expect(call[1]?.comparisonDetail).toBeFalsy();
  });

  it("reports why when the snapshot cannot be loaded", async () => {
    const provider = await resolveProvider();
    vi.spyOn(provider, "getAuditSnapshot").mockRejectedValue(new Error("Meta is down"));
    const gathered = await gatherDiagnoseEvidence({
      clientId: "client_modern_dental",
      request: REQUEST,
      intent: "comparison",
    });
    expect(gathered.evidence).toContain("### Comparison unavailable");
    expect(gathered.evidence).toContain("Meta is down");
    expect(gathered.comparisonBuilt).toBeFalsy();
  });

  it("the demo reply is the comparison evidence verbatim", async () => {
    const task = await createTask({
      clientId: "client_modern_dental",
      createdBy: "profile_operator_demo",
      title: REQUEST,
      goal: REQUEST,
    });
    const gathered = await gatherDiagnoseEvidence({ clientId: "client_modern_dental", request: REQUEST, intent: "comparison" });
    const result = await runAdspirerAgent({
      task,
      clientContext: "",
      toolEvidence: gathered.evidence,
      intent: "comparison",
    });
    expect(result.mode).toBe("mock");
    expect(result.summary).toContain("### Comparison evidence —");
    expect(result.summary).not.toContain("### Comparison framework");
    expect(result.toolCalls.map((c) => c.name).filter((n) => EXECUTE_TOOLS.has(n))).toEqual([]);
  });
});

const REPORT = [
  "# Meta Ads Comparison Report — Modern Dental",
  "",
  "## 1. Executive summary",
  "",
  "- Cost per lead rose from $32.10 to $41.80 between the two windows.",
  "",
  "## 2. Windows and data quality",
  "",
  "| Window | Dates | Days |",
  "| --- | --- | --- |",
  "| Current | 2026-11-03 to 2026-11-16 | 14 |",
  "| Previous | 2026-10-20 to 2026-11-02 | 14 |",
  "",
  "## 12. Findings and implications",
  "",
  "- CMP-001: results fell 18% while spend held, so cost per result rose.",
  "",
  "## 14. Appendix",
  "",
  "- Measurement notes. ".repeat(60),
].join("\n");

describe("comparison report export", () => {
  it("is not read as an account audit", () => {
    expect(looksLikeFullAuditMarkdown(REPORT)).toBe(false);
  });

  it("keeps its title and every numbered section", () => {
    const prepared = prepareExportMarkdown(REPORT, "Fallback");
    expect(prepared).toContain("# Meta Ads Comparison Report — Modern Dental");
    expect(prepared).toContain("## 12. Findings and implications");
    expect(inferExportTitle(REPORT, "Fallback")).toBe("Meta Ads Comparison Report — Modern Dental");
    const md = exportMarkdown("Fallback", REPORT);
    expect(md).toContain("## 12. Findings and implications");
    expect(md).toContain("CMP-001");
  });

  it("exports Word and PDF with the comparison title, not the audit one", async () => {
    const docx = await exportDocx("Fallback", REPORT);
    const xml = await (await JSZip.loadAsync(docx)).file("word/document.xml")!.async("string");
    expect(xml).toMatch(/META ADS COMPARISON REPORT/);
    expect(xml).toMatch(/>META ADS COMPARISON</);
    expect(xml).toContain("Meta Ads comparison");
    expect(xml).toContain("Findings and implications");
    expect(xml).not.toMatch(/Full Meta Ads audit/);

    const pdf = await exportPdf("Fallback", REPORT);
    const { text } = await extractText(await getDocumentProxy(new Uint8Array(pdf)), { mergePages: true });
    expect(text).toMatch(/Findings and implications/);
    expect(text).toMatch(/Modern Dental/);
    expect(text).not.toMatch(/META ADS AUDIT/);
    expect(text.replace(/ /g, "")).toMatch(/METAADSCOMPARISON/);
  });

  it("the payload keeps the comparison title and filename", async () => {
    const out = await exportReportPayload({ format: "docx", title: "Fallback", content: REPORT });
    expect(out.filename).toMatch(/meta-ads-comparison-report/);
  });
});
