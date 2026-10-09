import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  Header,
  LevelFormat,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TabStopType,
  TextRun,
  VerticalAlign,
  WidthType,
  type ParagraphChild,
} from "docx";
import type { InlineSpan, ReportBlock } from "@/lib/reports/parse-markdown";
import { parseMarkdownToBlocks, sanitizeReportText } from "@/lib/reports/parse-markdown";
import { columnAlignments, columnWeights, padRows } from "@/lib/reports/layout";
import { REPORT_THEME as T } from "@/lib/reports/template";

/**
 * Native Word (.docx) export. Replaces the old HTML-renamed-to-.doc file,
 * which Word opened with a format warning and rendered without zebra rows,
 * column widths or a proper cover.
 */

const FONT = "Calibri";
const MONO = "Consolas";
const hex = (c: string) => c.replace("#", "").toUpperCase();

// A4 with 1.8 cm side margins → usable width in twentieths of a point.
const PAGE_WIDTH_TWIP = 11906;
const MARGIN_TWIP = 1020;
const CONTENT_TWIP = PAGE_WIDTH_TWIP - MARGIN_TWIP * 2;

const URL_RE = /(https?:\/\/[^\s)]+)/g;
const HAIRLINE = { style: BorderStyle.SINGLE, size: 4, color: hex(T.border) };

function runsFor(text: string, style: { bold?: boolean; italics?: boolean; mono?: boolean; color?: string; size?: number } = {}): ParagraphChild[] {
  const base = {
    font: style.mono ? MONO : FONT,
    bold: style.bold,
    italics: style.italics,
    color: style.color,
    size: style.size,
  };
  return text.split(URL_RE).map((part, i) =>
    i % 2 === 1
      ? new ExternalHyperlink({
          link: part,
          children: [new TextRun({ ...base, text: part, style: "Hyperlink" })],
        })
      : new TextRun({ ...base, text: part }),
  );
}

function spanRuns(spans: InlineSpan[]): ParagraphChild[] {
  return spans.flatMap((span) =>
    runsFor(span.text, {
      bold: span.type === "bold",
      italics: span.type === "italic",
      mono: span.type === "code",
      color: span.type === "code" ? hex(T.primaryDark) : undefined,
    }),
  );
}

function tableFor(block: Extract<ReportBlock, { type: "table" }>): Table {
  const { headers, rows, columns } = padRows(block.headers, block.rows);
  const widths = columnWeights(headers, rows).map((w) => Math.round(w * CONTENT_TWIP));
  const align = columnAlignments(rows, columns);
  const cell = (text: string, c: number, opts: { header?: boolean; zebra?: boolean }) =>
    new TableCell({
      width: { size: widths[c], type: WidthType.DXA },
      verticalAlign: VerticalAlign.TOP,
      shading: opts.header
        ? { type: ShadingType.CLEAR, color: "auto", fill: hex(T.tableHeader) }
        : opts.zebra
          ? { type: ShadingType.CLEAR, color: "auto", fill: hex(T.surface) }
          : undefined,
      margins: { top: 60, bottom: 60, left: 100, right: 100 },
      children: [
        new Paragraph({
          alignment: align[c] === "right" ? AlignmentType.RIGHT : AlignmentType.LEFT,
          spacing: { before: 0, after: 0, line: 260 },
          children: runsFor(text, {
            bold: opts.header,
            color: opts.header ? hex(T.primaryDark) : undefined,
            size: 18,
          }),
        }),
      ],
    });

  return new Table({
    layout: TableLayoutType.FIXED,
    width: { size: CONTENT_TWIP, type: WidthType.DXA },
    columnWidths: widths,
    borders: {
      top: HAIRLINE,
      bottom: HAIRLINE,
      left: HAIRLINE,
      right: HAIRLINE,
      insideHorizontal: HAIRLINE,
      insideVertical: HAIRLINE,
    },
    rows: [
      // tableHeader repeats the header row on every page the table spans.
      new TableRow({
        tableHeader: true,
        cantSplit: true,
        children: headers.map((h, c) => cell(h, c, { header: true })),
      }),
      ...rows.map(
        (row, r) =>
          new TableRow({
            cantSplit: true,
            children: row.map((value, c) => cell(value, c, { zebra: r % 2 === 1 })),
          }),
      ),
    ],
  });
}

function blockChildren(blocks: ReportBlock[]): Array<Paragraph | Table> {
  const out: Array<Paragraph | Table> = [];
  let orderedList = 0;
  for (const block of blocks) {
    switch (block.type) {
      case "heading":
        out.push(
          new Paragraph({
            style: `H${block.level}`,
            keepNext: true,
            children: runsFor(block.text),
          }),
        );
        break;
      case "paragraph":
        out.push(new Paragraph({ style: "Body", children: spanRuns(block.spans) }));
        break;
      case "list": {
        // Each ordered list restarts at 1.
        const instance = block.ordered ? ++orderedList : 0;
        for (const item of block.items) {
          out.push(
            new Paragraph({
              style: "ListBody",
              numbering: block.ordered
                ? { reference: "ordered", level: 0, instance }
                : { reference: "bullets", level: 0 },
              children: spanRuns(item),
            }),
          );
        }
        break;
      }
      case "table":
        out.push(tableFor(block));
        // Word glues consecutive tables together without a spacer paragraph.
        out.push(new Paragraph({ spacing: { before: 0, after: 120 }, children: [] }));
        break;
      case "hr":
        out.push(
          new Paragraph({
            spacing: { before: 120, after: 120 },
            border: { bottom: { ...HAIRLINE, space: 1 } },
            children: [],
          }),
        );
        break;
    }
  }
  return out;
}

function cover(title: string, subtitle: string, dateLabel: string): Table {
  const white = hex(T.white);
  return new Table({
    width: { size: CONTENT_TWIP, type: WidthType.DXA },
    columnWidths: [CONTENT_TWIP],
    borders: {
      top: { style: BorderStyle.NONE, size: 0, color: "auto" },
      bottom: { style: BorderStyle.NONE, size: 0, color: "auto" },
      left: { style: BorderStyle.NONE, size: 0, color: "auto" },
      right: { style: BorderStyle.NONE, size: 0, color: "auto" },
      insideHorizontal: { style: BorderStyle.NONE, size: 0, color: "auto" },
      insideVertical: { style: BorderStyle.NONE, size: 0, color: "auto" },
    },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            width: { size: CONTENT_TWIP, type: WidthType.DXA },
            shading: { type: ShadingType.CLEAR, color: "auto", fill: hex(T.primary) },
            margins: { top: 360, bottom: 300, left: 360, right: 360 },
            children: [
              new Paragraph({
                spacing: { after: 120 },
                children: [
                  new TextRun({ text: "SPENDSMITH", font: FONT, bold: true, size: 16, color: hex(T.primaryLight), characterSpacing: 40 }),
                ],
              }),
              new Paragraph({
                spacing: { after: 100 },
                children: [new TextRun({ text: title, font: FONT, bold: true, size: 40, color: white })],
              }),
              new Paragraph({
                children: [
                  new TextRun({ text: `${subtitle} · ${dateLabel}`, font: FONT, size: 18, color: hex(T.primaryLight) }),
                ],
              }),
            ],
          }),
        ],
      }),
    ],
  });
}

function footer(dateLabel: string): Footer {
  const muted = hex(T.muted);
  return new Footer({
    children: [
      new Paragraph({
        tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_TWIP }],
        border: { top: { ...HAIRLINE, space: 4 } },
        children: [
          new TextRun({ text: `Confidential · Generated ${dateLabel}`, size: 15, color: muted }),
          new TextRun({
            children: ["\tPage ", PageNumber.CURRENT, " of ", PageNumber.TOTAL_PAGES],
            size: 15,
            color: muted,
          }),
        ],
      }),
    ],
  });
}

export async function renderReportDocx(input: {
  title: string;
  markdown: string;
  subtitle?: string;
  generatedAt?: Date;
}): Promise<Uint8Array> {
  const title = sanitizeReportText(input.title);
  let blocks = parseMarkdownToBlocks(input.markdown);
  if (
    blocks[0]?.type === "heading" &&
    blocks[0].level === 1 &&
    blocks[0].text.toLowerCase() === title.toLowerCase()
  ) {
    blocks = blocks.slice(1);
  }
  const dateLabel = (input.generatedAt ?? new Date()).toLocaleString("en-AU", {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const muted = hex(T.muted);

  const doc = new Document({
    creator: "Spendsmith",
    title,
    description: input.subtitle,
    styles: {
      default: {
        document: { run: { font: FONT, size: 21, color: hex(T.ink) } },
      },
      paragraphStyles: [
        {
          id: "Body",
          name: "Body",
          basedOn: "Normal",
          paragraph: { spacing: { after: 140, line: 300 } },
        },
        {
          id: "ListBody",
          name: "List body",
          basedOn: "Normal",
          paragraph: { spacing: { after: 60, line: 290 } },
        },
        {
          id: "H1",
          name: "Report heading 1",
          basedOn: "Normal",
          next: "Body",
          run: { size: 32, bold: true, color: hex(T.primaryDark) },
          paragraph: { spacing: { before: 360, after: 120 } },
        },
        {
          id: "H2",
          name: "Report heading 2",
          basedOn: "Normal",
          next: "Body",
          run: { size: 26, bold: true, color: hex(T.ink) },
          paragraph: {
            spacing: { before: 320, after: 120 },
            border: { bottom: { ...HAIRLINE, space: 4 } },
          },
        },
        {
          id: "H3",
          name: "Report heading 3",
          basedOn: "Normal",
          next: "Body",
          run: { size: 22, bold: true, color: hex(T.primary) },
          paragraph: { spacing: { before: 220, after: 80 } },
        },
      ],
    },
    numbering: {
      config: [
        {
          reference: "bullets",
          levels: [
            {
              level: 0,
              format: LevelFormat.BULLET,
              text: "•",
              alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 360, hanging: 260 } } },
            },
          ],
        },
        {
          reference: "ordered",
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: "%1.",
              alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 360, hanging: 300 } } },
            },
          ],
        },
      ],
    },
    sections: [
      {
        properties: {
          // Page 1 has the cover band, so it gets the empty "first" header.
          titlePage: true,
          page: {
            size: { width: PAGE_WIDTH_TWIP, height: 16838 },
            margin: { top: 1080, bottom: 1080, left: MARGIN_TWIP, right: MARGIN_TWIP },
          },
        },
        headers: {
          first: new Header({ children: [new Paragraph({ children: [] })] }),
          default: new Header({
            children: [
              new Paragraph({
                tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_TWIP }],
                border: { bottom: { ...HAIRLINE, space: 4 } },
                children: [
                  new TextRun({ text: title, size: 15, color: muted }),
                  new TextRun({ text: "\tSPENDSMITH", size: 15, color: muted }),
                ],
              }),
            ],
          }),
        },
        footers: {
          first: footer(dateLabel),
          default: footer(dateLabel),
        },
        children: [
          cover(title, input.subtitle ?? "Meta Ads report", dateLabel),
          new Paragraph({ spacing: { after: 200 }, children: [] }),
          ...blockChildren(blocks),
        ],
      },
    ],
  });

  return new Uint8Array(await Packer.toBuffer(doc));
}
