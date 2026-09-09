import {
  type InlineSpan,
  type ReportBlock,
  parseMarkdownToBlocks,
  sanitizeReportText,
} from "@/lib/reports/parse-markdown";
import { REPORT_THEME } from "@/lib/reports/template";

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN_X = 48;
const MARGIN_TOP = 56;
const MARGIN_BOTTOM = 52;
const CONTENT_W = PAGE_W - MARGIN_X * 2;

type PdfOp = string;

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

function pdfEscape(value: string): string {
  // Never run full sanitize/trim here — trimming spaces collapses word gaps
  // and makes neighbouring glyphs look merged or oddly stretched.
  return value
    .replace(/\u00A0/g, " ")
    .replace(/[^\x20-\x7E]/g, (ch) => {
      if (ch === "\n" || ch === "\r" || ch === "\t") return " ";
      return "";
    })
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

/** Approximate Helvetica character width in points at size 1. */
function charWidth(ch: string, bold: boolean): number {
  const c = ch.charCodeAt(0);
  // Keep space honest — too-narrow spaces make words look glued in the PDF.
  if (c === 32) return 0.3;
  if (c === 45) return 0.33; // hyphen
  if (c >= 65 && c <= 90) return bold ? 0.7 : 0.66;
  if (c >= 97 && c <= 122) return bold ? 0.55 : 0.52;
  if (c >= 48 && c <= 57) return 0.55;
  return bold ? 0.52 : 0.5;
}

function measure(text: string, fontSize: number, bold: boolean): number {
  let w = 0;
  for (const ch of text) w += charWidth(ch, bold) * fontSize;
  return w;
}

function wrapText(
  text: string,
  fontSize: number,
  bold: boolean,
  maxWidth: number,
): string[] {
  const words = sanitizeReportText(text).split(/\s+/).filter(Boolean);
  if (!words.length) return [""];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (measure(next, fontSize, bold) <= maxWidth) {
      current = next;
    } else {
      if (current) lines.push(current);
      if (measure(word, fontSize, bold) > maxWidth) {
        // Hard-break long tokens
        let rest = word;
        while (measure(rest, fontSize, bold) > maxWidth) {
          let cut = Math.max(1, Math.floor(maxWidth / (fontSize * 0.5)));
          while (
            cut > 1 &&
            measure(rest.slice(0, cut), fontSize, bold) > maxWidth
          ) {
            cut -= 1;
          }
          lines.push(rest.slice(0, cut));
          rest = rest.slice(cut);
        }
        current = rest;
      } else {
        current = word;
      }
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

function spansToRuns(spans: InlineSpan[]): Array<{ text: string; bold: boolean }> {
  const runs: Array<{ text: string; bold: boolean }> = [];
  for (const span of spans) {
    runs.push({
      text: span.text,
      bold: span.type === "bold" || span.type === "code",
    });
  }
  return runs.length ? runs : [{ text: "", bold: false }];
}

function wrapRuns(
  spans: InlineSpan[],
  fontSize: number,
  maxWidth: number,
): Array<Array<{ text: string; bold: boolean }>> {
  const runs = spansToRuns(spans);
  const lines: Array<Array<{ text: string; bold: boolean }>> = [];
  let line: Array<{ text: string; bold: boolean }> = [];
  let lineWidth = 0;

  const pushWord = (word: string, bold: boolean) => {
    const space = line.length ? measure(" ", fontSize, false) : 0;
    const w = measure(word, fontSize, bold);
    if (lineWidth + space + w > maxWidth && line.length) {
      lines.push(line);
      line = [{ text: word, bold }];
      lineWidth = w;
    } else {
      if (line.length) {
        line.push({ text: " ", bold: false });
        lineWidth += space;
      }
      line.push({ text: word, bold });
      lineWidth += w;
    }
  };

  for (const run of runs) {
    // Keep intentional spaces between styled spans; only skip pure padding
    // that would double up with pushWord's inter-word gap.
    const words = run.text.split(/(\s+)/);
    for (const part of words) {
      if (!part) continue;
      if (/^\s+$/.test(part)) {
        // Preserve a boundary space only when the next non-space token would
        // otherwise glue to the previous — pushWord already inserts gaps.
        continue;
      }
      pushWord(part, run.bold);
    }
  }
  if (line.length) lines.push(line);
  return lines.length ? lines : [[{ text: "", bold: false }]];
}

type Page = { ops: PdfOp[] };

function newPage(): Page {
  return { ops: [] };
}

function drawCover(page: Page, title: string, dateLabel: string) {
  const [r, g, b] = hexToRgb(REPORT_THEME.primary);
  page.ops.push(`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg`);
  page.ops.push(`0 ${PAGE_H - 118} ${PAGE_W} 118 re f`);
  page.ops.push("1 1 1 rg");

  page.ops.push("BT");
  page.ops.push(`/F2 9 Tf`);
  page.ops.push(`${MARGIN_X} ${PAGE_H - 36} Td`);
  page.ops.push(`(${pdfEscape("ADSPIRER AI")}) Tj`);
  page.ops.push("ET");

  const titleLines = wrapText(title, 18, true, CONTENT_W).slice(0, 3);
  let y = PAGE_H - 62;
  for (const line of titleLines) {
    page.ops.push("BT");
    page.ops.push(`/F2 18 Tf`);
    page.ops.push(`${MARGIN_X} ${y} Td`);
    page.ops.push(`(${pdfEscape(line)}) Tj`);
    page.ops.push("ET");
    y -= 22;
  }

  page.ops.push("BT");
  page.ops.push(`/F1 9 Tf`);
  page.ops.push(`${MARGIN_X} ${PAGE_H - 108} Td`);
  page.ops.push(
    `(${pdfEscape(`Meta Ads operator report  ·  ${dateLabel}`)}) Tj`,
  );
  page.ops.push("ET");
}

function drawFooter(page: Page, pageNum: number, pageCount: number) {
  const [r, g, b] = hexToRgb(REPORT_THEME.primary);
  page.ops.push(`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} RG`);
  page.ops.push("1.5 w");
  page.ops.push(
    `${MARGIN_X} ${MARGIN_BOTTOM - 12} m ${PAGE_W - MARGIN_X} ${MARGIN_BOTTOM - 12} l S`,
  );
  page.ops.push("0.4 0.45 0.5 rg");
  page.ops.push("BT");
  page.ops.push(`/F1 8 Tf`);
  page.ops.push(`${MARGIN_X} ${MARGIN_BOTTOM - 28} Td`);
  page.ops.push(
    `(${pdfEscape(`Confidential  ·  Page ${pageNum} of ${pageCount}`)}) Tj`,
  );
  page.ops.push("ET");
}

function ensureSpace(state: {
  pages: Page[];
  page: Page;
  y: number;
  needed: number;
}): void {
  if (state.y - state.needed >= MARGIN_BOTTOM) return;
  state.pages.push(state.page);
  state.page = newPage();
  state.y = PAGE_H - MARGIN_TOP;
}

function drawTextLine(
  page: Page,
  x: number,
  y: number,
  runs: Array<{ text: string; bold: boolean }>,
  fontSize: number,
  rgb: [number, number, number],
) {
  let cursor = x;
  for (const run of runs) {
    if (!run.text) continue;
    page.ops.push(
      `${rgb[0].toFixed(3)} ${rgb[1].toFixed(3)} ${rgb[2].toFixed(3)} rg`,
    );
    page.ops.push("BT");
    page.ops.push(`/${run.bold ? "F2" : "F1"} ${fontSize} Tf`);
    page.ops.push(`${cursor.toFixed(2)} ${y.toFixed(2)} Td`);
    page.ops.push(`(${pdfEscape(run.text)}) Tj`);
    page.ops.push("ET");
    cursor += measure(run.text, fontSize, run.bold);
  }
}

export function exportBrandedPdf(title: string, markdown: string): Uint8Array {
  const cleanTitle = sanitizeReportText(title);
  const dateLabel = new Date().toLocaleString("en-AU", {
    dateStyle: "medium",
    timeStyle: "short",
  });

  let blocks = parseMarkdownToBlocks(markdown);
  if (
    blocks[0]?.type === "heading" &&
    blocks[0].level === 1 &&
    blocks[0].text.toLowerCase() === cleanTitle.toLowerCase()
  ) {
    blocks = blocks.slice(1);
  }

  const pages: Page[] = [];
  let page = newPage();
  drawCover(page, cleanTitle, dateLabel);
  let y = PAGE_H - 140;

  const ink = hexToRgb(REPORT_THEME.ink);
  const primary = hexToRgb(REPORT_THEME.primary);
  const primaryDark = hexToRgb(REPORT_THEME.primaryDark);
  const border = hexToRgb(REPORT_THEME.border);
  const tableHeader = hexToRgb(REPORT_THEME.tableHeader);

  const state = { pages, page, y, needed: 0 };

  const advance = (amount: number) => {
    state.y -= amount;
  };

  for (const block of blocks) {
    if (block.type === "hr") {
      state.needed = 16;
      ensureSpace(state);
      state.page.ops.push(
        `${border[0].toFixed(3)} ${border[1].toFixed(3)} ${border[2].toFixed(3)} RG`,
      );
      state.page.ops.push("0.8 w");
      state.page.ops.push(
        `${MARGIN_X} ${state.y} m ${PAGE_W - MARGIN_X} ${state.y} l S`,
      );
      advance(16);
      continue;
    }

    if (block.type === "heading") {
      const size = block.level === 1 ? 16 : block.level === 2 ? 13 : 11;
      const color = block.level === 3 ? ink : primaryDark;
      const lines = wrapText(block.text, size, true, CONTENT_W);
      state.needed = lines.length * (size + 4) + 14;
      ensureSpace(state);
      advance(block.level === 1 ? 10 : 8);
      for (const line of lines) {
        drawTextLine(
          state.page,
          MARGIN_X,
          state.y,
          [{ text: line, bold: true }],
          size,
          color,
        );
        advance(size + 4);
      }
      // underline
      state.page.ops.push(
        `${primary[0].toFixed(3)} ${primary[1].toFixed(3)} ${primary[2].toFixed(3)} RG`,
      );
      state.page.ops.push(block.level === 1 ? "1.5 w" : "0.8 w");
      state.page.ops.push(
        `${MARGIN_X} ${state.y + 2} m ${PAGE_W - MARGIN_X} ${state.y + 2} l S`,
      );
      advance(8);
      continue;
    }

    if (block.type === "paragraph") {
      const fontSize = 10;
      const wrapped = wrapRuns(block.spans, fontSize, CONTENT_W);
      state.needed = wrapped.length * 14 + 6;
      ensureSpace(state);
      for (const line of wrapped) {
        drawTextLine(state.page, MARGIN_X, state.y, line, fontSize, ink);
        advance(14);
      }
      advance(6);
      continue;
    }

    if (block.type === "list") {
      const fontSize = 10;
      for (let idx = 0; idx < block.items.length; idx += 1) {
        const bullet = block.ordered ? `${idx + 1}.` : "•";
        const wrapped = wrapRuns(block.items[idx], fontSize, CONTENT_W - 18);
        state.needed = wrapped.length * 14 + 2;
        ensureSpace(state);
        drawTextLine(
          state.page,
          MARGIN_X,
          state.y,
          [{ text: bullet, bold: true }],
          fontSize,
          primary,
        );
        for (let li = 0; li < wrapped.length; li += 1) {
          drawTextLine(
            state.page,
            MARGIN_X + 16,
            state.y,
            wrapped[li],
            fontSize,
            ink,
          );
          advance(14);
        }
      }
      advance(6);
      continue;
    }

    if (block.type === "table") {
      const cols = Math.max(block.headers.length, 1);
      const colW = CONTENT_W / cols;
      const fontSize = 9;
      const pad = 5;

      const drawRow = (cells: string[], header: boolean) => {
        const cellLines = cells.map((c) =>
          wrapText(c || " ", fontSize, header, colW - pad * 2),
        );
        const rowH =
          Math.max(...cellLines.map((l) => l.length), 1) * 11 + pad * 2;
        state.needed = rowH + 2;
        ensureSpace(state);

        if (header) {
          state.page.ops.push(
            `${tableHeader[0].toFixed(3)} ${tableHeader[1].toFixed(3)} ${tableHeader[2].toFixed(3)} rg`,
          );
          state.page.ops.push(
            `${MARGIN_X} ${state.y - rowH} ${CONTENT_W} ${rowH} re f`,
          );
        }

        state.page.ops.push(
          `${border[0].toFixed(3)} ${border[1].toFixed(3)} ${border[2].toFixed(3)} RG`,
        );
        state.page.ops.push("0.6 w");
        state.page.ops.push(
          `${MARGIN_X} ${state.y - rowH} ${CONTENT_W} ${rowH} re S`,
        );
        for (let c = 1; c < cols; c += 1) {
          const x = MARGIN_X + colW * c;
          state.page.ops.push(
            `${x} ${state.y} m ${x} ${state.y - rowH} l S`,
          );
        }

        for (let c = 0; c < cols; c += 1) {
          const lines = cellLines[c] ?? [""];
          let ty = state.y - pad - fontSize;
          for (const line of lines) {
            drawTextLine(
              state.page,
              MARGIN_X + colW * c + pad,
              ty,
              [{ text: line, bold: header }],
              fontSize,
              header ? primaryDark : ink,
            );
            ty -= 11;
          }
        }
        advance(rowH);
      };

      const headers = [...block.headers];
      while (headers.length < cols) headers.push("");
      drawRow(headers.slice(0, cols), true);
      for (const row of block.rows) {
        const cells = [...row];
        while (cells.length < cols) cells.push("");
        drawRow(cells.slice(0, cols), false);
      }
      advance(10);
    }
  }

  state.pages.push(state.page);
  const allPages = state.pages;
  const pageCount = allPages.length;

  // Rebuild pages with footers (need page count)
  for (let i = 0; i < allPages.length; i += 1) {
    drawFooter(allPages[i], i + 1, pageCount);
  }

  return buildPdfDocument(allPages);
}

function buildPdfDocument(pages: Page[]): Uint8Array {
  const objects: string[] = [];
  // 1 catalog, 2 pages, then per page: page obj + content stream, then 2 fonts
  const pageCount = pages.length;
  const pageObjIds: number[] = [];
  let nextId = 3;
  for (let i = 0; i < pageCount; i += 1) {
    pageObjIds.push(nextId);
    nextId += 2; // page + contents
  }
  const fontRegularId = nextId;
  const fontBoldId = nextId + 1;

  objects.push("1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj");
  objects.push(
    `2 0 obj<< /Type /Pages /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageCount} >>endobj`,
  );

  for (let i = 0; i < pageCount; i += 1) {
    const pageId = pageObjIds[i];
    const contentId = pageId + 1;
    const stream = pages[i].ops.join("\n");
    objects.push(
      `${pageId} 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontRegularId} 0 R /F2 ${fontBoldId} 0 R >> >> >>endobj`,
    );
    objects.push(
      `${contentId} 0 obj<< /Length ${Buffer.byteLength(stream, "utf8")} >>stream\n${stream}\nendstream endobj`,
    );
  }

  objects.push(
    `${fontRegularId} 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj`,
  );
  objects.push(
    `${fontBoldId} 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>endobj`,
  );

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += `${obj}\n`;
  }
  const xrefPos = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let i = 1; i < offsets.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefPos}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}
