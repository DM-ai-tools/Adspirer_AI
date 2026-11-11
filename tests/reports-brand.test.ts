import JSZip from "jszip";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { extractText, getDocumentProxy } from "unpdf";
import { BRAND, brandLogo, brandMark } from "@/lib/reports/brand-assets";
import { exportReportPayload } from "@/lib/reports/export";
import { splitTitle } from "@/lib/reports/pdf-document";
import { BRAND_BARS, REPORT_THEME } from "@/lib/reports/template";

const AUDIT = `# Meta Ads Account Audit — Chiro Care - TR

## 1. Executive Summary
- **Score 66/100 (C)**

## 2. Account Snapshot
| Metric | Value |
|---|---|
| Spend | A$17,025 |
| Leads | 171 |

## 3. Performance Breakdown
| Campaign | Spend (AUD) | Leads |
|---|---|---|
| TR \\| Messages | 4,267 | 38 |
| TR \\| Store Ad | 2,428 | 24 |
| **Total** | **6,695** | **62** |

*Read: TR | Messages takes 63.7% of spend.*
`;

describe("Traffic Radius branding", () => {
  it("uses the logo and the colours taken from trafficradius.com.au", async () => {
    const logo = brandLogo();
    const mark = brandMark();
    expect(logo && mark).toBeTruthy();
    const meta = await sharp(logo!).metadata();
    expect(meta.width! / meta.height!).toBeCloseTo(BRAND.logoAspect, 2);
    expect(BRAND_BARS).toEqual(["#0C0D0D", "#3EB8E7", "#A4D36B"]);
    expect(REPORT_THEME.navy).toBe("#072032");
  });

  it("splits the title into the cover's eyebrow and the account name", () => {
    expect(splitTitle("Meta Ads Account Audit — Chiro Care - TR")).toEqual({ eyebrow: "META ADS ACCOUNT AUDIT", name: "Chiro Care - TR" });
    expect(splitTitle("Campaign publish report")).toEqual({ eyebrow: null, name: "Campaign publish report" });
  });

  it("puts the logo, the brand header and the brand footer in the Word file", async () => {
    const r = await exportReportPayload({ format: "docx", title: "Meta Ads Account Audit — Chiro Care - TR", content: AUDIT });
    const zip = await JSZip.loadAsync(r.body as Uint8Array);
    const media = Object.keys(zip.files).filter((f) => f.startsWith("word/media/"));
    expect(media.length).toBeGreaterThanOrEqual(2); // the cover logo and the header mark
    const all = (await Promise.all(Object.keys(zip.files).filter((f) => /^word\/(document|header\d*|footer\d*)\.xml$/.test(f)).map((f) => zip.file(f)!.async("string")))).join("\n");
    const text = all.replace(/<[^>]+>/g, "");
    expect(text).toContain("Chiro Care - TR");
    expect(text).toContain("META ADS ACCOUNT AUDIT");
    expect(text).toContain("TRAFFIC RADIUS");
    expect(text).toContain("Prepared by Traffic Radius");
    expect(all).toContain('w:fill="072032"'); // navy panel, headings and table headers
    expect(all).toContain('w:fill="F1F8E8"'); // the total row and the read line in light green
    expect(text).not.toMatch(/CampaignForge|CAMPAIGNFORGE/);
  }, 30_000);

  it("puts the logo and the brand footer in the PDF, on every page", async () => {
    const r = await exportReportPayload({ format: "pdf", title: "Meta Ads Account Audit — Chiro Care - TR", content: AUDIT });
    const bytes = r.body as Uint8Array;
    expect(Buffer.from(bytes).toString("latin1")).toMatch(/\/Subtype\s*\/Image/);
    const { text } = await extractText(await getDocumentProxy(new Uint8Array(bytes)), { mergePages: true });
    expect(text).toContain("Chiro Care - TR");
    expect(text).toContain("Prepared by Traffic Radius");
    expect(text).not.toMatch(/CampaignForge|CAMPAIGNFORGE/);
    expect(r.filename).toBe("meta-ads-account-audit-chiro-care-tr.pdf");
  }, 30_000);
});
