import {
  Document,
  Link,
  Page,
  StyleSheet,
  Text,
  View,
  renderToBuffer,
} from "@react-pdf/renderer";
import type { StyleProp } from "@react-pdf/stylesheet";
import type { InlineSpan, ReportBlock } from "@/lib/reports/parse-markdown";
import { parseMarkdownToBlocks, sanitizeReportText } from "@/lib/reports/parse-markdown";
import { columnAlignments, columnWeights, padRows } from "@/lib/reports/layout";
import { ensureReportFonts } from "@/lib/report/pdf/fonts";
import { REPORT_THEME as T } from "@/lib/reports/template";

/**
 * Branded report PDF, typeset by @react-pdf with the embedded Inter font.
 *
 * Replaces the old hand-written PDF writer, which positioned every word from
 * estimated character widths (words overlapped or drifted apart) and could
 * only draw ASCII (→, –, ₹, curly quotes vanished, merging neighbouring text).
 */

const PAGE_X = 48;
const PAGE_TOP = 62;
const PAGE_BOTTOM = 58;

const s = StyleSheet.create({
  page: {
    paddingTop: PAGE_TOP,
    paddingBottom: PAGE_BOTTOM,
    paddingHorizontal: PAGE_X,
    fontFamily: "Inter",
    fontSize: 9.5,
    // No lineHeight here: on the Page it makes react-pdf drop `render`-prop
    // text (the page numbers). Body text styles set it instead.
    color: T.ink,
  },
  // Running header (pages 2+) and footer.
  runningHeader: {
    position: "absolute",
    top: 26,
    left: PAGE_X,
    right: PAGE_X,
    flexDirection: "row",
    justifyContent: "space-between",
    fontSize: 7.5,
    color: T.muted,
    borderBottomWidth: 0.5,
    borderBottomColor: T.border,
    paddingBottom: 6,
  },
  footer: {
    position: "absolute",
    bottom: 26,
    left: PAGE_X,
    right: PAGE_X,
    flexDirection: "row",
    justifyContent: "space-between",
    fontSize: 7.5,
    color: T.muted,
    borderTopWidth: 0.5,
    borderTopColor: T.border,
    paddingTop: 6,
  },
  // Cover band on page one, bleeding to the page edges.
  cover: {
    marginTop: -PAGE_TOP,
    marginHorizontal: -PAGE_X,
    marginBottom: 22,
    paddingTop: 34,
    paddingBottom: 24,
    paddingHorizontal: PAGE_X,
    backgroundColor: T.primary,
  },
  brand: {
    fontSize: 8,
    fontWeight: 600,
    letterSpacing: 1.6,
    color: T.primaryLight,
    marginBottom: 10,
  },
  title: {
    fontSize: 20,
    fontWeight: 700,
    lineHeight: 1.25,
    color: T.white,
  },
  subtitle: {
    marginTop: 8,
    fontSize: 9,
    color: T.primaryLight,
  },
  h1: {
    fontSize: 15,
    fontWeight: 700,
    color: T.primaryDark,
    marginTop: 16,
    marginBottom: 6,
    lineHeight: 1.3,
  },
  h2: {
    fontSize: 12,
    fontWeight: 600,
    color: T.ink,
    marginTop: 16,
    marginBottom: 7,
    paddingBottom: 4,
    borderBottomWidth: 0.75,
    borderBottomColor: T.border,
    lineHeight: 1.3,
  },
  h3: {
    fontSize: 10.5,
    fontWeight: 600,
    color: T.primary,
    marginTop: 11,
    marginBottom: 4,
    lineHeight: 1.3,
  },
  // Line heights are absolute (pt): a unitless value compounds on nested
  // text runs in react-pdf and double-spaces paragraphs.
  paragraph: { marginBottom: 7, lineHeight: "14pt" },
  link: { color: T.primary, textDecoration: "none" },
  bold: { fontWeight: 600 },
  italic: { fontStyle: "italic" },
  code: {
    fontFamily: "JetBrainsMono",
    fontSize: 8.5,
    color: T.primaryDark,
  },
  list: { marginBottom: 7 },
  listItem: { flexDirection: "row", marginBottom: 3 },
  bullet: { width: 14, color: T.primary, lineHeight: "14pt" },
  number: { width: 18, color: T.primary, fontWeight: 600, lineHeight: "14pt" },
  listText: { flex: 1, lineHeight: "14pt" },
  table: {
    marginTop: 4,
    marginBottom: 12,
    borderWidth: 0.5,
    borderColor: T.border,
  },
  row: { flexDirection: "row" },
  rowAlt: { backgroundColor: T.surface },
  headRow: {
    flexDirection: "row",
    backgroundColor: T.tableHeader,
    borderBottomWidth: 0.75,
    borderBottomColor: T.primaryLight,
  },
  cell: {
    paddingVertical: 4,
    paddingHorizontal: 6,
    fontSize: 8.5,
    lineHeight: "11.5pt",
    borderRightWidth: 0.5,
    borderRightColor: T.border,
  },
  headCell: {
    fontWeight: 600,
    color: T.primaryDark,
  },
  rowDivider: { borderTopWidth: 0.5, borderTopColor: T.border },
  hr: {
    height: 0.75,
    backgroundColor: T.border,
    marginVertical: 10,
  },
});

const URL_RE = /(https?:\/\/[^\s)]+)/g;
const LINK_LABEL_MAX = 40;

/** Inter covers almost everything; map the few symbols it lacks. */
function glyphSafe(text: string): string {
  return text.replace(/✔/g, "✓").replace(/✕/g, "×");
}

/**
 * Readable label for a link: domain + path, no tracking parameters, capped in
 * length. react-pdf can only wrap words at spaces (or with an inserted "-"),
 * so a raw 120-character URL either overflows or gets broken mid-word. The
 * full URL stays clickable.
 */
export function linkLabel(url: string): string {
  let label = url;
  try {
    const u = new URL(url);
    label = `${u.hostname.replace(/^www\./, "")}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    label = url.replace(/^https?:\/\//, "");
  }
  return label.length > LINK_LABEL_MAX ? `${label.slice(0, LINK_LABEL_MAX - 1)}…` : label;
}

type TextStyle = StyleProp;

function TextWithLinks({ text, style }: { text: string; style?: TextStyle }) {
  const parts = glyphSafe(text).split(URL_RE);
  if (parts.length === 1) return <Text style={style}>{parts[0]}</Text>;
  return (
    <Text style={style}>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <Link key={i} src={part} style={s.link}>
            {linkLabel(part)}
          </Link>
        ) : (
          part
        ),
      )}
    </Text>
  );
}

function Spans({ spans }: { spans: InlineSpan[] }) {
  return (
    <>
      {spans.map((span, i) => {
        if (span.type === "bold") return <TextWithLinks key={i} style={s.bold} text={span.text} />;
        if (span.type === "italic") return <TextWithLinks key={i} style={s.italic} text={span.text} />;
        if (span.type === "code") return <Text key={i} style={s.code}>{glyphSafe(span.text)}</Text>;
        return <TextWithLinks key={i} text={span.text} />;
      })}
    </>
  );
}

function Table({ block }: { block: Extract<ReportBlock, { type: "table" }> }) {
  const { headers, rows, columns } = padRows(block.headers, block.rows);
  const widths = columnWeights(headers, rows);
  const align = columnAlignments(rows, columns);
  const cellStyle = (c: number) => [
    s.cell,
    {
      width: `${(widths[c] * 100).toFixed(2)}%`,
      textAlign: align[c],
    } as const,
    c === columns - 1 ? { borderRightWidth: 0 } : {},
  ];

  return (
    <View style={s.table}>
      {/* `fixed` repeats the header row on every page the table spans. */}
      <View style={s.headRow} fixed>
        {headers.map((h, c) => (
          <Text key={c} style={[...cellStyle(c), s.headCell]}>
            {glyphSafe(h)}
          </Text>
        ))}
      </View>
      {rows.map((row, r) => (
        <View
          key={r}
          wrap={false}
          style={[s.row, r > 0 ? s.rowDivider : {}, r % 2 === 1 ? s.rowAlt : {}]}
        >
          {row.map((cell, c) => (
            <TextWithLinks key={c} style={cellStyle(c)} text={cell} />
          ))}
        </View>
      ))}
    </View>
  );
}

function Block({ block }: { block: ReportBlock }) {
  switch (block.type) {
    case "heading": {
      const style = block.level === 1 ? s.h1 : block.level === 2 ? s.h2 : s.h3;
      // Keep a heading on the same page as the first lines below it.
      return (
        <Text style={style} minPresenceAhead={48}>
          {glyphSafe(block.text)}
        </Text>
      );
    }
    case "paragraph":
      return (
        <Text style={s.paragraph}>
          <Spans spans={block.spans} />
        </Text>
      );
    case "list":
      return (
        <View style={s.list}>
          {block.items.map((item, i) => (
            <View key={i} style={s.listItem} wrap={false}>
              <Text style={block.ordered ? s.number : s.bullet}>
                {block.ordered ? `${i + 1}.` : "•"}
              </Text>
              <Text style={s.listText}>
                <Spans spans={item} />
              </Text>
            </View>
          ))}
        </View>
      );
    case "table":
      return <Table block={block} />;
    case "hr":
      return <View style={s.hr} />;
    default:
      return null;
  }
}

export function ReportPdfDocument(props: {
  title: string;
  subtitle: string;
  generatedLabel: string;
  blocks: ReportBlock[];
}) {
  const title = glyphSafe(props.title);
  return (
    <Document title={title} author="Spendsmith" creator="Spendsmith" producer="Spendsmith">
      <Page size="A4" style={s.page}>
        <View
          style={s.runningHeader}
          fixed
          render={({ pageNumber }) =>
            pageNumber > 1 ? (
              <>
                <Text>{title}</Text>
                <Text>SPENDSMITH</Text>
              </>
            ) : null
          }
        />

        <View style={s.cover}>
          <Text style={s.brand}>SPENDSMITH</Text>
          <Text style={s.title}>{title}</Text>
          <Text style={s.subtitle}>
            {props.subtitle} · {props.generatedLabel}
          </Text>
        </View>

        {props.blocks.map((block, i) => (
          <Block key={i} block={block} />
        ))}

        <View style={s.footer} fixed>
          <Text>Confidential · Generated {props.generatedLabel}</Text>
          <Text
            render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`}
          />
        </View>
      </Page>
    </Document>
  );
}

export async function renderReportPdf(input: {
  title: string;
  markdown: string;
  subtitle?: string;
  generatedAt?: Date;
}): Promise<Uint8Array> {
  ensureReportFonts();
  const title = sanitizeReportText(input.title);
  let blocks = parseMarkdownToBlocks(input.markdown);
  // The cover already shows the title — drop a duplicate leading H1.
  if (
    blocks[0]?.type === "heading" &&
    blocks[0].level === 1 &&
    blocks[0].text.toLowerCase() === title.toLowerCase()
  ) {
    blocks = blocks.slice(1);
  }
  const generatedLabel = (input.generatedAt ?? new Date()).toLocaleString("en-AU", {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const buffer = await renderToBuffer(
    <ReportPdfDocument
      title={title}
      subtitle={input.subtitle ?? "Meta Ads report"}
      generatedLabel={generatedLabel}
      blocks={blocks}
    />,
  );
  return new Uint8Array(buffer);
}
