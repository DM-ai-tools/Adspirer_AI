import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { buildRunsWorkbook, buildTables, parseOnImageText, parseStyle } from "@/lib/creatives/bulk/export";
import { directionWithText } from "@/lib/creatives/concept-writer";
import { withAspectMarker, withRunMarker } from "@/lib/creatives/formats";
import type { CreativeDraft } from "@/lib/creatives/drafts";
import type { CreativeRun } from "@/lib/creatives/bulk/runs";

const direction = withRunMarker(
  withAspectMarker(
    directionWithText("STYLE: Tactile 3D render. ANGLE: Remove the risk (Most aware, targets: fear). A glass funnel.", {
      headline: "Nothing to lose",
      highlights: ["Free audit", "48-hr start"],
      cta_label: "Book a call",
    }),
    "9:16",
  ),
  "run_abc",
);

const draft = (id: string, over: Partial<CreativeDraft> = {}) =>
  ({
    id,
    client_id: "c1",
    headline: `Headline ${id}`,
    primary_text: "=SUM(1,1) body copy",
    cta: "GET_QUOTE",
    creative_direction: direction,
    image_status: "succeeded",
    status: "draft",
    landing_page_url: "https://acme.test",
    ...over,
  }) as CreativeDraft;

const run = {
  id: "run_abc",
  client_id: "c1",
  landing_page_url: "https://acme.test",
  inputs: { notes: "n" },
  image_format: "9:16",
  status: "done",
  message_map: { pains: ["slow"], desires: ["growth"], objections: ["cost"], proof: ["1500 brands"], mechanism: "m", audience: "a" },
  bodies: [{ id: "A", format: "proof", text: "Body A text" }],
  items: [
    { draft_id: "d1", angle_key: "risk", angle_name: "Remove the risk", stage: "most_aware", kind: "objection", targets: "fear of wasting money", body_id: "A", cta_label: "Book a call" },
    { draft_id: "d2", angle_key: "x", angle_name: "Other", stage: "unaware", kind: "hope", targets: "t", body_id: "A", cta_label: "Go" },
  ],
  created_at: "2026-11-05T10:00:00.000Z",
} as unknown as CreativeRun;

describe("bulk export", () => {
  it("reads the printed words and style back from the art direction", () => {
    expect(parseOnImageText(direction)).toEqual({ headline: "Nothing to lose", labels: ["Free audit", "48-hr start"], button: "Book a call" });
    expect(parseStyle(direction)).toBe("Tactile 3D render");
  });

  it("makes one row per image with the link, copy, angle, style and words", () => {
    const drafts = new Map([["d1", draft("d1")], ["d2", draft("d2", { image_status: "failed" })]]);
    const ads = buildTables([{ run, drafts }])[0]!;
    expect(ads.rows).toHaveLength(2);
    const col = (name: string) => ads.header.indexOf(name);
    const first = ads.rows[0]!;
    expect(first[col("Angle")]).toBe("Remove the risk");
    expect(first[col("Awareness stage")]).toBe("Most aware");
    expect(first[col("Art style")]).toBe("Tactile 3D render");
    expect(first[col("On-image labels")]).toBe("Free audit | 48-hr start");
    expect(first[col("Body format")]).toBe("proof");
    expect(first[col("Image size")]).toBe("9:16");
    expect((first[col("Image link")] as { link: string }).link).toMatch(/\/api\/creatives\/assets\/d1$/);
    expect(first[col("Visual direction")]).not.toMatch(/RUN:|ASPECT:|ON-IMAGE/);
    // a failed render has no image link
    expect(ads.rows[1]![col("Image link")]).toBe("");
    expect(ads.rows[1]![col("Status")]).toBe("Failed");
  });

  it("writes a workbook that opens, with clickable links and no live formulas", () => {
    const drafts = new Map([["d1", draft("d1")], ["d2", draft("d2")]]);
    const wb = XLSX.read(buildRunsWorkbook([{ run, drafts }]), { type: "array" });
    expect(wb.SheetNames).toEqual(["Ads", "Bodies", "Message map", "Runs"]);
    const ads = wb.Sheets["Ads"]!;
    const header = XLSX.utils.sheet_to_json<string[]>(ads, { header: 1 })[0]!;
    const linkCol = header.indexOf("Image link");
    const cell = ads[XLSX.utils.encode_cell({ r: 1, c: linkCol })]!;
    expect(cell.l?.Target).toMatch(/\/api\/creatives\/assets\/d1$/);
    const copyCol = header.indexOf("Primary text (ad copy)");
    expect(String(ads[XLSX.utils.encode_cell({ r: 1, c: copyCol })]!.v).startsWith("'=")).toBe(true);
  });

  it("combines several runs for the history export", () => {
    const drafts = new Map([["d1", draft("d1")], ["d2", draft("d2")]]);
    const other = { ...run, id: "run_two" } as CreativeRun;
    const [ads, , , runs] = buildTables([{ run, drafts }, { run: other, drafts }]);
    expect(ads!.rows).toHaveLength(4);
    expect(runs!.rows.map((r) => r[1])).toEqual(["run_abc", "run_two"]);
  });
});
