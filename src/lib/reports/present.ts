import type { CardTone, InlineSpan, ReportBlock } from "@/lib/reports/parse-markdown";

/**
 * Presentation pass for printed exports (PDF, Word, HTML). One pass, so every format shows the same
 * report the same way:
 *
 * - A **Metric | Value** table becomes a row of KPI tiles.
 * - A risk (### R1 · Critical — …), a recommendation (### 1. …) or a change (**date — …** followed
 *   by Who / Verdict lines) becomes a framed card, coloured by severity or verdict, with its
 *   labelled lines laid out as label and value.
 * - An italic "Read: …" line under a table becomes a highlighted takeaway; other italic lines that
 *   start with "*" are footnotes.
 * - A table row whose first cell is "Total" is printed as a total.
 * - A table whose cells hold sentences becomes cards (a heading per row, a labelled line per column).
 *
 * Tables of numbers, dates and short labels stay tables.
 */

type Table = Extract<ReportBlock, { type: "table" }>;
type List = Extract<ReportBlock, { type: "list" }>;

/** A cell that reads as a sentence, not a value. */
const LONG_CELL = 48;
/** A leading cell this short is a tag (severity, #, status) and joins the title. */
const TAG_CELL = 14;

const clean = (cell: string) => cell.replace(/\s+/g, " ").trim();
const plain = (spans: InlineSpan[]) => spans.map((s) => s.text).join("").replace(/\s+/g, " ").trim();

/** Wide tables with prose in at least two columns, or very long prose in one. */
export function isTextHeavyTable(block: Table): boolean {
  const columns = Math.max(block.headers.length, ...block.rows.map((r) => r.length));
  if (columns < 3 || block.rows.length === 0) return false;
  const longColumns = Array.from({ length: columns }, (_, c) => {
    const cells = block.rows.map((r) => clean(r[c] ?? "")).filter(Boolean);
    if (!cells.length) return false;
    const long = cells.filter((cell) => cell.length > LONG_CELL).length;
    return long / cells.length >= 0.5;
  }).filter(Boolean).length;
  const longest = Math.max(...block.rows.flatMap((r) => r.map((cell) => clean(cell).length)));
  return longColumns >= 2 || (longColumns >= 1 && longest > 140);
}

function tableToCards(block: Table): ReportBlock[] {
  const headers = block.headers.map(clean);
  const out: ReportBlock[] = [];
  for (const raw of block.rows) {
    const cells = headers.map((_, c) => clean(raw[c] ?? ""));
    // Title: leading tag cells (severity, number) plus the first sentence-length cell.
    let titleEnd = 0;
    while (titleEnd < cells.length - 1 && cells[titleEnd]!.length <= TAG_CELL) titleEnd += 1;
    const titleCells = cells.slice(0, titleEnd + 1).filter(Boolean);
    const title = titleCells.join(" · ") || "—";
    out.push({ type: "heading", level: 3, text: title });
    const items = cells
      .map((cell, c) => ({ cell, c }))
      .filter(({ cell, c }) => c > titleEnd && cell && !/^(—|–|-|n\/a)$/i.test(cell))
      .map(({ cell, c }) => [
        { type: "bold" as const, text: `${headers[c] || `Column ${c + 1}`}:` },
        { type: "text" as const, text: ` ${cell}` },
      ]);
    if (items.length) out.push({ type: "list", ordered: false, items });
  }
  return out;
}

// ------------------------------------------------------------------ KPI tiles

const KPI_HEADER = /^(metric|kpi|measure)$/i;
const VALUE_HEADER = /^(value|result|figure|total)$/i;
/** More tiles than this read as a wall: the rest stay a table. */
const MAX_TILES = 16;

export function asKpis(block: Table): Extract<ReportBlock, { type: "kpis" }> | null {
  if (block.headers.length !== 2 || !KPI_HEADER.test(clean(block.headers[0] ?? "")) || !VALUE_HEADER.test(clean(block.headers[1] ?? ""))) return null;
  const items = block.rows.map((r) => ({ label: clean(r[0] ?? ""), value: clean(r[1] ?? "") })).filter((i) => i.label && i.value);
  if (items.length < 2 || items.length > MAX_TILES || items.some((i) => i.value.length > 28)) return null;
  return { type: "kpis", items };
}

// ------------------------------------------------------------------ cards

const RISK = /^R(\d+)\s*[·.:\-–—]?\s*(?:(Critical|High|Medium|Low)\b)?\s*[—–\-:·]*\s*(.*)$/i;
const ACTION = /^(\d{1,2})[.)]\s+(.+)$/;
const LABELLED = /^([A-Z][A-Za-z /&()'+-]{1,28}):\s*(.*)$/;

/** Split "**Evidence:** text" into a label and its value; null for a plain bullet. */
function labelled(item: InlineSpan[]): { label: string; value: InlineSpan[] } | null {
  const first = item[0];
  if (first?.type === "bold") {
    const m = /^(.{1,30}?):\s*$/.exec(first.text.trim()) ?? /^(.{1,30}?):$/.exec(first.text.trim());
    if (m) {
      const rest = item.slice(1).map((s, i) => (i === 0 ? { ...s, text: s.text.replace(/^\s+/, "") } : s)).filter((s) => s.text.length);
      return { label: m[1]!.trim(), value: rest.length ? rest : [{ type: "text", text: "—" }] };
    }
  }
  const text = plain(item);
  const m = LABELLED.exec(text);
  return m && m[2] ? { label: m[1]!.trim(), value: [{ type: "text", text: m[2] }] } : null;
}

/** A line that carries several labelled parts ("**Effort:** Low · **When:** Week 1") becomes one field per part. */
function splitFields(item: InlineSpan[]): Array<{ label: string; value: InlineSpan[] }> | null {
  const boldLabels = item.filter((s) => s.type === "bold" && /:\s*$/.test(s.text)).length;
  if (boldLabels < 2) {
    const one = labelled(item);
    return one ? [one] : null;
  }
  const out: Array<{ label: string; value: InlineSpan[] }> = [];
  for (const span of item) {
    if (span.type === "bold" && /:\s*$/.test(span.text)) out.push({ label: span.text.replace(/:\s*$/, "").trim(), value: [] });
    else if (out.length) out[out.length - 1]!.value.push({ ...span, text: span.text.replace(/^\s*[·|]\s*|\s*[·|]\s*$/g, "") });
  }
  return out.map((f) => {
    const value = f.value.filter((s) => s.text.trim());
    if (value[0]) value[0] = { ...value[0], text: value[0].text.replace(/^\s+/, "") };
    return { ...f, value: value.length ? value : [{ type: "text" as const, text: "—" }] };
  });
}

const EMPTY_VALUE = "—";

function fieldsOf(list: List) {
  const fields: Array<{ label: string; value: InlineSpan[] }> = [];
  const notes: InlineSpan[][] = [];
  // "**Fix:**" with its steps as sub-bullets underneath: the steps are that field's value, not loose notes.
  let open: { field: { label: string; value: InlineSpan[] }; steps: InlineSpan[][] } | null = null;
  const close = () => {
    if (open?.steps.length) {
      const { field, steps } = open;
      field.value = steps.length === 1
        ? steps[0]!
        : steps.flatMap((step, i) => [{ type: "text" as const, text: `${i ? "  " : ""}${i + 1}) ` }, ...step]);
    }
    open = null;
  };
  for (const item of list.items) {
    const parts = splitFields(item);
    if (parts) {
      close();
      fields.push(...parts);
      const last = parts[parts.length - 1]!;
      const emptyLast = last.value.length === 1 && last.value[0]!.text === EMPTY_VALUE;
      const field = fields[fields.length - 1]!;
      if (emptyLast) open = { field, steps: [] };
    } else if (open) {
      (open as { steps: InlineSpan[][] }).steps.push(item);
    } else {
      notes.push(item);
    }
  }
  close();
  return { fields, notes };
}

const toneOfSeverity = (s: string | undefined): CardTone => {
  const v = (s ?? "").toLowerCase();
  return v === "critical" ? "critical" : v === "high" ? "high" : v === "medium" ? "medium" : v === "low" ? "low" : "neutral";
};

function verdictTone(fields: Array<{ label: string; value: InlineSpan[] }>): CardTone {
  const verdict = fields.find((f) => /^verdict$/i.test(f.label));
  const v = verdict ? plain(verdict.value).toLowerCase() : "";
  if (/wrong call/.test(v)) return "negative";
  if (/justified/.test(v)) return "positive";
  return "neutral";
}

/** A heading followed by a list of mostly labelled lines is a card. */
function cardFrom(heading: string, list: List): Extract<ReportBlock, { type: "card" }> | null {
  const { fields, notes } = fieldsOf(list);
  if (!fields.length || fields.length < notes.length) return null;
  const risk = RISK.exec(heading);
  if (risk) {
    return { type: "card", tone: toneOfSeverity(risk[2]), tag: `R${risk[1]}${risk[2] ? ` · ${risk[2][0]!.toUpperCase()}${risk[2].slice(1).toLowerCase()}` : ""}`, title: risk[3]!.trim() || heading, fields, notes };
  }
  const action = ACTION.exec(heading);
  if (action) return { type: "card", tone: "action", tag: action[1]!, title: action[2]!.trim(), fields, notes };
  return { type: "card", tone: verdictTone(fields), tag: null, title: heading, fields, notes };
}

/** A paragraph that is only a bold line (a change's title) and is followed by labelled lines. */
function boldTitle(block: ReportBlock): string | null {
  if (block.type !== "paragraph") return null;
  const spans = block.spans.filter((s) => s.text.trim());
  if (!spans.length || spans[0]!.type !== "bold") return null;
  const text = plain(block.spans);
  return text.length <= 160 ? text : null;
}

// ------------------------------------------------------------------ notes

function noteOf(block: ReportBlock): Extract<ReportBlock, { type: "note" }> | null {
  if (block.type !== "paragraph") return null;
  const spans = block.spans.filter((s) => s.text.trim());
  if (spans.length !== 1 || spans[0]!.type !== "italic") return null;
  const text = spans[0]!.text.trim();
  if (/^read:/i.test(text)) return { type: "note", kind: "read", spans: [{ type: "bold", text: "Read: " }, { type: "text", text: text.replace(/^read:\s*/i, "") }] };
  return { type: "note", kind: "footnote", spans: [{ type: "text", text: text.replace(/^\\?\*\s*/, "* ") }] };
}

// ------------------------------------------------------------------ the pass

export function presentBlocks(blocks: ReportBlock[]): ReportBlock[] {
  const out: ReportBlock[] = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i]!;
    const next = blocks[i + 1];

    if (block.type === "heading" && block.level === 3 && next?.type === "list" && (RISK.test(block.text) || ACTION.test(block.text))) {
      const card = cardFrom(block.text, next);
      if (card) {
        out.push(card);
        i += 1;
        continue;
      }
    }
    const title = boldTitle(block);
    if (title && next?.type === "list") {
      const card = cardFrom(title, next);
      if (card && card.fields.some((f) => /^(who|verdict|ran|before → after|before -> after)$/i.test(f.label))) {
        out.push(card);
        i += 1;
        continue;
      }
    }
    const note = noteOf(block);
    if (note) {
      out.push(note);
      continue;
    }
    if (block.type === "table") {
      const kpis = asKpis(block);
      if (kpis) {
        out.push(kpis);
        continue;
      }
      if (isTextHeavyTable(block)) {
        out.push(...presentBlocks(tableToCards(block)));
        continue;
      }
      const strongRows = block.rows.map((r, idx) => (/^total\b/i.test(clean(r[0] ?? "")) ? idx : -1)).filter((idx) => idx >= 0);
      out.push(strongRows.length ? { ...block, strongRows } : block);
      continue;
    }
    out.push(block);
  }
  return out;
}
