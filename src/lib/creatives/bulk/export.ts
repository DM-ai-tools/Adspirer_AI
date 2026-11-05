import * as XLSX from "xlsx";
import { neutraliseFormula } from "@/lib/reports/tabular";
import { publicCreativeAssetUrl, type CreativeDraft } from "@/lib/creatives/drafts";
import { readAspectMarker, stripAspectMarker } from "@/lib/creatives/formats";
import { STAGE_LABEL, type AwarenessStage } from "@/lib/creatives/bulk/angles";
import type { CreativeRun } from "@/lib/creatives/bulk/runs";

/**
 * Excel export of bulk runs: one row per image with its link, copy, angle, style and on-image
 * words, plus the bodies that were reused, the message map the hooks came from, and a summary of
 * each run. Works for one run or the whole history.
 */

export type ExportRun = { run: CreativeRun; drafts: Map<string, CreativeDraft> };

/** The words printed on the image, read back from the art direction. */
export function parseOnImageText(direction: string | null | undefined): { headline: string; labels: string[]; button: string } {
  const line = (direction ?? "").split("\n").find((l) => l.trim().startsWith("ON-IMAGE TEXT")) ?? "";
  const quoted = (re: RegExp) => line.match(re)?.[1]?.trim() ?? "";
  const headline = quoted(/headline "([^"]*)"/);
  const button = quoted(/call-to-action button "([^"]*)"/);
  const keywords = line.match(/highlighted keywords ([^;]*);/)?.[1] ?? "";
  const labels = [...keywords.matchAll(/"([^"]*)"/g)].map((m) => m[1]!.trim()).filter(Boolean);
  return { headline, labels, button };
}

/** The style named in the art direction ("STYLE: Tactile 3D render. ANGLE: …"). */
export function parseStyle(direction: string | null | undefined): string {
  return (direction ?? "").match(/STYLE: ([^.]+)\./)?.[1]?.trim() ?? "";
}

/** The art direction without the bookkeeping lines and the printed-words line, which have their own columns. */
function visualDirection(direction: string | null | undefined): string {
  return stripAspectMarker(direction)
    .split("\n")
    .filter((l) => !l.trim().startsWith("ON-IMAGE TEXT"))
    .join("\n")
    .trim();
}

export function formatStamp(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  let tz = timeZone;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
  } catch {
    tz = "UTC";
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

type Cell = string | number | { text: string; link: string };
type Table = { name: string; header: string[]; widths: number[]; rows: Cell[][] };

function statusOf(d: CreativeDraft | undefined): string {
  if (!d) return "Missing";
  if (d.status === "rejected") return "Rejected";
  if (d.image_status === "succeeded") return d.status === "selected" ? "Ready (chosen for campaign)" : "Ready";
  if (d.image_status === "failed") return "Failed";
  if (d.image_status === "generating") return "Rendering";
  return "Waiting";
}

/** The sheets, as plain tables, so they can be tested without opening a workbook. */
export function buildTables(runs: ExportRun[], timeZone = "UTC"): Table[] {
  const adRows: Cell[][] = [];
  const bodyRows: Cell[][] = [];
  const mapRows: Cell[][] = [];
  const runRows: Cell[][] = [];

  for (const { run, drafts } of runs) {
    const when = formatStamp(run.created_at, timeZone);
    const bodyUse = new Map<string, number>();
    run.items.forEach((item) => item.body_id && bodyUse.set(item.body_id, (bodyUse.get(item.body_id) ?? 0) + 1));
    const bodyFormat = new Map((run.bodies ?? []).map((b) => [b.id, b.format]));

    run.items.forEach((item, index) => {
      const d = drafts.get(item.draft_id);
      const on = parseOnImageText(d?.creative_direction);
      const image = d && d.image_status === "succeeded" ? publicCreativeAssetUrl(d.id) : "";
      adRows.push([
        when,
        run.id,
        index + 1,
        statusOf(d),
        item.angle_name ?? "",
        item.stage ? (STAGE_LABEL[item.stage as AwarenessStage] ?? item.stage) : "",
        item.kind ?? "",
        item.targets ?? "",
        parseStyle(d?.creative_direction),
        d?.headline ?? "",
        d?.primary_text ?? "",
        item.body_id ?? "",
        item.body_id ? (bodyFormat.get(item.body_id) ?? "") : "",
        item.cta_label ?? "",
        d?.cta ?? "",
        on.headline,
        on.labels.join(" | "),
        on.button,
        image ? { text: image, link: image } : "",
        image ? { text: "Download", link: `${image}?download=1` } : "",
        run.landing_page_url ?? d?.landing_page_url ?? "",
        d ? (readAspectMarker(d.creative_direction) ?? run.image_format) : run.image_format,
        d ? visualDirection(d.creative_direction) : "",
        d?.id ?? item.draft_id,
      ]);
    });

    for (const b of run.bodies ?? []) {
      bodyRows.push([when, run.id, b.id, b.format, bodyUse.get(b.id) ?? 0, b.text]);
    }
    const m = run.message_map;
    if (m) {
      const add = (kind: string, list: string[] | string) =>
        (Array.isArray(list) ? list : [list]).filter(Boolean).forEach((v) => mapRows.push([when, run.id, kind, v]));
      add("Pain", m.pains);
      add("Desire", m.desires);
      add("Objection", m.objections);
      add("Proof", m.proof);
      add("Mechanism", m.mechanism);
      add("Audience", m.audience);
    }

    const all = run.items.map((i) => drafts.get(i.draft_id));
    runRows.push([
      when,
      run.id,
      run.status,
      run.landing_page_url ?? "",
      run.image_format,
      run.items.length,
      all.filter((d) => d?.image_status === "succeeded" && d.status !== "rejected").length,
      all.filter((d) => d?.image_status === "failed").length,
      all.filter((d) => d?.status === "rejected").length,
      run.inputs.notes ?? "",
      run.inputs.pastedCopy ?? "",
    ]);
  }

  return [
    {
      name: "Ads",
      header: [
        "Run date", "Run ID", "#", "Status", "Angle", "Awareness stage", "Motivation type",
        "What it targets", "Art style", "Headline", "Primary text (ad copy)", "Body", "Body format", "CTA button", "CTA type",
        "On-image headline", "On-image labels", "On-image button", "Image link", "Download link", "Landing page", "Image size",
        "Visual direction", "Draft ID",
      ],
      widths: [17, 16, 5, 16, 24, 15, 14, 40, 24, 32, 70, 6, 14, 18, 14, 30, 30, 18, 46, 12, 36, 9, 70, 18],
      rows: adRows,
    },
    { name: "Bodies", header: ["Run date", "Run ID", "Body", "Format", "Ads using it", "Body text"], widths: [17, 16, 6, 14, 12, 90], rows: bodyRows },
    { name: "Message map", header: ["Run date", "Run ID", "Type", "Detail"], widths: [17, 16, 12, 100], rows: mapRows },
    {
      name: "Runs",
      header: ["Run date", "Run ID", "Status", "Landing page", "Image size", "Ads", "Ready", "Failed", "Rejected", "Notes given", "Copy given"],
      widths: [17, 16, 11, 40, 10, 6, 7, 7, 9, 40, 40],
      rows: runRows,
    },
  ];
}

export function buildRunsWorkbook(runs: ExportRun[], timeZone = "UTC"): Uint8Array {
  const wb = XLSX.utils.book_new();
  for (const table of buildTables(runs, timeZone)) {
    // A sheet with only a header would open as an empty tab; leave those out except the main one.
    if (!table.rows.length && table.name !== "Ads") continue;
    const ws: XLSX.WorkSheet = {};
    const put = (r: number, c: number, cell: Cell, bold = false) => {
      const ref = XLSX.utils.encode_cell({ r, c });
      if (typeof cell === "number") ws[ref] = { t: "n", v: cell };
      else if (typeof cell === "string") ws[ref] = { t: "s", v: neutraliseFormula(cell) };
      else ws[ref] = { t: "s", v: cell.text, l: { Target: cell.link, Tooltip: cell.link } };
      if (bold) (ws[ref] as XLSX.CellObject & { s?: unknown }).s = { font: { bold: true } };
    };
    table.header.forEach((h, c) => put(0, c, h, true));
    table.rows.forEach((row, r) => row.forEach((cell, c) => put(r + 1, c, cell)));
    ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: table.rows.length, c: table.header.length - 1 } });
    ws["!cols"] = table.widths.map((wch) => ({ wch }));
    ws["!autofilter"] = { ref: ws["!ref"] };
    ws["!freeze"] = { xSplit: 0, ySplit: 1 };
    XLSX.utils.book_append_sheet(wb, ws, table.name);
  }
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx", compression: true }) as ArrayBuffer);
}
