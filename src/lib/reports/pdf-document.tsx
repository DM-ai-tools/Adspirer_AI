import { presentBlocks } from "@/lib/reports/present";
import {
  Document,
  Image,
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
import { chunkWord, columnAlignments, fitTableColumns, padRows } from "@/lib/reports/layout";
import { ensureReportFonts } from "@/lib/report/pdf/fonts";
import { BRAND_BARS, CARD_TONES, REPORT_THEME as T } from "@/lib/reports/template";
import { BRAND, brandLogo, brandMark } from "@/lib/reports/brand-assets";

/**
 * Report PDF in the Traffic Radius brand, typeset by @react-pdf: Montserrat (the site's typeface)
 * for headings and the cover, Inter for body text and tables. Page one opens with the logo on
 * white, a band in the logo's three colours and a black title panel; every later page carries the
 * bar mark in its header and the agency's name in its footer.
 */

const PAGE_X = 46;
const PAGE_TOP = 64;
const PAGE_BOTTOM = 60;
const HEAD = "Montserrat";

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
    top: 22,
    left: PAGE_X,
    right: PAGE_X,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingBottom: 7,
    borderBottomWidth: 1.5,
    borderBottomColor: T.lime,
  },
  headerBrand: { flexDirection: "row", alignItems: "center" },
  headerMark: { width: 9, height: 14, marginRight: 6 },
  headerName: { fontFamily: HEAD, fontWeight: 700, fontSize: 8.5, color: T.dark, letterSpacing: 0.3 },
  headerTitle: { fontSize: 7.5, color: T.muted, maxWidth: 330, textAlign: "right" },
  footer: {
    position: "absolute",
    bottom: 22,
    left: PAGE_X,
    right: PAGE_X,
    flexDirection: "row",
    justifyContent: "space-between",
    fontSize: 7.2,
    color: T.muted,
    borderTopWidth: 0.5,
    borderTopColor: T.border,
    paddingTop: 7,
  },
  footerBrand: { fontFamily: HEAD, fontWeight: 600, color: T.dark },
  // Cover: logo on white, the logo's three colours as a band, then the black title panel.
  coverTop: {
    marginTop: -PAGE_TOP,
    marginHorizontal: -PAGE_X,
    paddingTop: 30,
    paddingBottom: 18,
    paddingHorizontal: PAGE_X,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
    backgroundColor: T.white,
  },
  coverLogo: { width: 190, height: 190 / BRAND.logoAspect },
  coverLogoText: { fontFamily: HEAD, fontWeight: 800, fontSize: 20, color: T.ink },
  coverMeta: { alignItems: "flex-end" },
  coverKind: { fontFamily: HEAD, fontWeight: 700, fontSize: 8, letterSpacing: 1.6, color: T.dark },
  coverDate: { fontSize: 8, color: T.muted, marginTop: 3 },
  band: { flexDirection: "row", marginHorizontal: -PAGE_X, height: 5 },
  hero: {
    marginHorizontal: -PAGE_X,
    marginBottom: 22,
    paddingTop: 26,
    paddingBottom: 24,
    paddingHorizontal: PAGE_X,
    backgroundColor: T.dark,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
  },
  heroText: { flex: 1, paddingRight: 24 },
  eyebrow: { fontFamily: HEAD, fontWeight: 700, fontSize: 8.5, letterSpacing: 1.8, color: T.lime, marginBottom: 8 },
  title: { fontFamily: HEAD, fontWeight: 800, fontSize: 24, lineHeight: 1.18, color: T.white },
  subtitle: { marginTop: 10, fontSize: 8.8, color: "#B8BCC2" },
  heroBars: { flexDirection: "row", alignItems: "flex-end", height: 62 },
  heroBar: { width: 11, marginLeft: 6 },
  h1: { fontFamily: HEAD, fontSize: 16, fontWeight: 800, color: T.dark, marginTop: 16, marginBottom: 6, lineHeight: 1.25 },
  h2: {
    fontFamily: HEAD,
    fontSize: 12.5,
    fontWeight: 700,
    color: T.white,
    backgroundColor: T.dark,
    marginTop: 20,
    marginBottom: 10,
    paddingVertical: 6,
    paddingLeft: 10,
    borderLeftWidth: 4,
    borderLeftColor: T.lime,
    lineHeight: 1.25,
  },
  h3: { fontFamily: HEAD, fontSize: 10.5, fontWeight: 700, color: T.skyInk, marginTop: 13, marginBottom: 5, lineHeight: 1.3 },
  // Line heights are absolute (pt): a unitless value compounds on nested
  // text runs in react-pdf and double-spaces paragraphs.
  paragraph: { marginBottom: 7, lineHeight: "14pt" },
  link: { color: T.skyInk, textDecoration: "none" },
  bold: { fontWeight: 600, color: T.dark },
  italic: { fontStyle: "italic" },
  code: { fontFamily: "JetBrainsMono", fontSize: 8.5, color: T.dark },
  list: { marginBottom: 7 },
  listItem: { flexDirection: "row", marginBottom: 3 },
  bullet: { width: 13, color: T.lime, fontWeight: 700, lineHeight: "14pt" },
  number: { width: 18, color: T.skyInk, fontWeight: 600, lineHeight: "14pt" },
  listText: { flex: 1, lineHeight: "14pt" },
  table: { marginTop: 4, marginBottom: 12, borderWidth: 0.5, borderColor: T.border },
  row: { flexDirection: "row" },
  rowAlt: { backgroundColor: T.surface },
  headRow: { flexDirection: "row", backgroundColor: T.dark },
  cell: {
    paddingVertical: 4,
    paddingHorizontal: 6,
    fontSize: 8.5,
    lineHeight: "11.5pt",
    borderRightWidth: 0.5,
    borderRightColor: T.border,
  },
  headCell: { fontWeight: 600, color: T.white, borderRightColor: "#2E3033" },
  rowDivider: { borderTopWidth: 0.5, borderTopColor: T.border },
  hr: { height: 0.75, backgroundColor: T.border, marginVertical: 10 },
  strongRow: { backgroundColor: T.limeSoft, borderTopWidth: 1, borderTopColor: T.lime },
  strongCell: { fontWeight: 700, color: T.dark },
  // KPI tiles: four to a row, each edged in one of the logo's colours.
  kpis: { flexDirection: "row", flexWrap: "wrap", marginTop: 2, marginBottom: 10, marginHorizontal: -3 },
  kpi: { width: "25%", paddingHorizontal: 3, marginBottom: 6 },
  kpiInner: {
    borderWidth: 0.5,
    borderColor: T.border,
    borderTopWidth: 3,
    backgroundColor: T.white,
    paddingVertical: 7,
    paddingHorizontal: 8,
    minHeight: 48,
  },
  kpiValue: { fontFamily: HEAD, fontSize: 13, fontWeight: 700, color: T.dark, lineHeight: "16pt" },
  kpiLabel: { fontSize: 7, color: T.muted, marginTop: 3, lineHeight: "9pt", textTransform: "uppercase", letterSpacing: 0.4 },
  // Cards: risks, recommendations, changes.
  card: { marginBottom: 8, borderLeftWidth: 4, paddingVertical: 8, paddingHorizontal: 11 },
  cardHead: { flexDirection: "row", alignItems: "flex-start", marginBottom: 5 },
  cardTag: { fontFamily: HEAD, fontSize: 7.5, fontWeight: 700, color: T.white, paddingVertical: 2, paddingHorizontal: 6, marginRight: 8, borderRadius: 2 },
  cardTitle: { flex: 1, fontFamily: HEAD, fontSize: 10, fontWeight: 700, color: T.dark, lineHeight: "13pt" },
  field: { flexDirection: "row", marginTop: 2 },
  fieldLabel: { width: 94, fontSize: 8.3, fontWeight: 600, color: T.darkSoft, lineHeight: "12pt" },
  fieldValue: { flex: 1, fontSize: 8.8, lineHeight: "12pt" },
  // A takeaway under a table, and a footnote.
  read: {
    marginTop: -6,
    marginBottom: 12,
    paddingVertical: 5,
    paddingHorizontal: 9,
    backgroundColor: T.limeSoft,
    borderLeftWidth: 3,
    borderLeftColor: T.lime,
    fontSize: 8.6,
    lineHeight: "12pt",
    color: T.dark,
  },
  footnote: { marginBottom: 8, fontSize: 7.4, lineHeight: "10pt", color: T.muted },
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

function TextWithLinks({
  text,
  style,
  hyphenationCallback,
}: {
  text: string;
  style?: TextStyle;
  hyphenationCallback?: (word: string) => string[];
}) {
  const parts = glyphSafe(text).split(URL_RE);
  if (parts.length === 1)
    return (
      <Text style={style} hyphenationCallback={hyphenationCallback}>
        {parts[0]}
      </Text>
    );
  return (
    <Text style={style} hyphenationCallback={hyphenationCallback}>
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

/** A4 width minus the side margins and the table's outer border. */
const TABLE_WIDTH = 595.28 - PAGE_X * 2 - 1;

function Table({ block }: { block: Extract<ReportBlock, { type: "table" }> }) {
  const { headers, rows, columns } = padRows(block.headers, block.rows);
  // Wide tables (a 12-column ad set table) step down in type size so every
  // word fits its column; only words that still don't fit break mid-word.
  const fit = fitTableColumns(headers, rows, { availableWidth: TABLE_WIDTH });
  const align = columnAlignments(rows, columns);
  const cellStyle = (c: number) => [
    s.cell,
    {
      width: fit.widths[c],
      textAlign: align[c],
      fontSize: fit.fontSize,
      lineHeight: `${(fit.fontSize * 1.35).toFixed(1)}pt`,
      paddingHorizontal: fit.paddingX,
    } as const,
    c === columns - 1 ? { borderRightWidth: 0 } : {},
  ];
  const breakAt = (c: number, header = false) => {
    if (!fit.breakWords[c]) return undefined;
    const chars = header ? Math.max(1, Math.floor(fit.maxWordChars[c]! * 0.9)) : fit.maxWordChars[c]!;
    return (word: string) => chunkWord(word, chars);
  };

  return (
    <View style={s.table}>
      {/* `fixed` repeats the header row on every page the table spans. */}
      <View style={s.headRow} fixed>
        {headers.map((h, c) => (
          <Text key={c} style={[...cellStyle(c), s.headCell]} hyphenationCallback={breakAt(c, true)}>
            {glyphSafe(h)}
          </Text>
        ))}
      </View>
      {rows.map((row, r) => {
        const strong = block.strongRows?.includes(r);
        return (
          <View
            key={r}
            wrap={false}
            style={[s.row, r > 0 ? s.rowDivider : {}, r % 2 === 1 ? s.rowAlt : {}, strong ? s.strongRow : {}]}
          >
            {row.map((cell, c) => (
              <TextWithLinks key={c} style={[...cellStyle(c), strong ? s.strongCell : {}]} text={cell} hyphenationCallback={breakAt(c)} />
            ))}
          </View>
        );
      })}
    </View>
  );
}

function Block({ block }: { block: ReportBlock }) {
  switch (block.type) {
    case "heading": {
      const style = block.level === 1 ? s.h1 : block.level === 2 ? s.h2 : s.h3;
      // Keep a heading on the same page as the first lines below it.
      return (
        <Text style={style} minPresenceAhead={56}>
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
              <Text style={block.ordered ? s.number : s.bullet}>{block.ordered ? `${i + 1}.` : "■"}</Text>
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
    case "kpis":
      return (
        <View style={s.kpis}>
          {block.items.map((item, i) => (
            <View key={i} style={s.kpi} wrap={false}>
              <View style={[s.kpiInner, { borderTopColor: [T.dark, T.sky, T.lime][i % 3] }]}>
                <Text style={s.kpiValue}>{glyphSafe(item.value)}</Text>
                <Text style={s.kpiLabel}>{glyphSafe(item.label)}</Text>
              </View>
            </View>
          ))}
        </View>
      );
    case "card": {
      const tone = CARD_TONES[block.tone];
      return (
        <View style={[s.card, { borderLeftColor: tone.bar, backgroundColor: tone.fill }]} wrap={false}>
          <View style={s.cardHead}>
            {block.tag ? <Text style={[s.cardTag, { backgroundColor: block.tone === "action" ? T.dark : tone.bar }]}>{glyphSafe(block.tag)}</Text> : null}
            <Text style={s.cardTitle}>{glyphSafe(block.title)}</Text>
          </View>
          {block.fields.map((f, i) => (
            <View key={i} style={s.field}>
              <Text style={s.fieldLabel}>{glyphSafe(f.label)}</Text>
              <Text style={s.fieldValue}>
                <Spans spans={f.value} />
              </Text>
            </View>
          ))}
          {block.notes.map((n, i) => (
            <View key={`n${i}`} style={s.field}>
              <Text style={[s.fieldLabel, { width: 10, color: T.lime }]}>■</Text>
              <Text style={s.fieldValue}>
                <Spans spans={n} />
              </Text>
            </View>
          ))}
        </View>
      );
    }
    case "note":
      return (
        <Text style={block.kind === "read" ? s.read : s.footnote}>
          <Spans spans={block.spans} />
        </Text>
      );
    default:
      return null;
  }
}

/** "Meta Ads Account Audit — Chiro Care - TR" → eyebrow "META ADS ACCOUNT AUDIT", name "Chiro Care - TR". */
export function splitTitle(title: string): { eyebrow: string | null; name: string } {
  const m = /^(.{6,60}?)\s+[—–]\s+(.+)$/.exec(title.trim());
  return m ? { eyebrow: m[1]!.toUpperCase(), name: m[2]!.trim() } : { eyebrow: null, name: title.trim() };
}

export function ReportPdfDocument(props: {
  title: string;
  subtitle: string;
  generatedLabel: string;
  blocks: ReportBlock[];
  logo?: Buffer | null;
  mark?: Buffer | null;
}) {
  const title = glyphSafe(props.title);
  const { eyebrow, name } = splitTitle(title);
  const kind = /audit/i.test(title) ? "META ADS AUDIT" : "META ADS REPORT";
  return (
    <Document title={title} author={BRAND.name} creator={BRAND.name} producer={BRAND.name}>
      <Page size="A4" style={s.page}>
        <View
          style={s.runningHeader}
          fixed
          render={({ pageNumber }) =>
            pageNumber > 1 ? (
              <>
                <View style={s.headerBrand}>
                  {props.mark ? <Image src={props.mark} style={s.headerMark} /> : null}
                  <Text style={s.headerName}>{BRAND.name.toUpperCase()}</Text>
                </View>
                <Text style={s.headerTitle}>{title}</Text>
              </>
            ) : null
          }
        />

        <View style={s.coverTop}>
          {props.logo ? <Image src={props.logo} style={s.coverLogo} /> : <Text style={s.coverLogoText}>{BRAND.name}</Text>}
          <View style={s.coverMeta}>
            <Text style={s.coverKind}>{kind}</Text>
            <Text style={s.coverDate}>{props.generatedLabel}</Text>
          </View>
        </View>
        <View style={s.band}>
          {BRAND_BARS.map((c) => (
            <View key={c} style={{ flex: 1, backgroundColor: c }} />
          ))}
        </View>
        <View style={s.hero}>
          <View style={s.heroText}>
            {eyebrow ? <Text style={s.eyebrow}>{eyebrow}</Text> : null}
            <Text style={s.title}>{name}</Text>
            <Text style={s.subtitle}>{props.subtitle}</Text>
          </View>
          {/* The logo's three bars, as the cover's mark. */}
          <View style={s.heroBars}>
            {[0.42, 0.7, 1].map((h, i) => (
              <View key={i} style={[s.heroBar, { height: 62 * h, backgroundColor: i === 0 ? T.white : BRAND_BARS[i] }]} />
            ))}
          </View>
        </View>

        {props.blocks.map((block, i) => (
          <Block key={i} block={block} />
        ))}

        <View style={s.footer} fixed>
          <Text>
            <Text style={s.footerBrand}>Prepared by {BRAND.name}</Text> · {BRAND.site} · Confidential
          </Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
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
  let blocks = presentBlocks(parseMarkdownToBlocks(input.markdown));
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
      subtitle={input.subtitle ?? `Meta Ads report · Prepared by ${BRAND.name}`}
      generatedLabel={generatedLabel}
      blocks={blocks}
      logo={brandLogo()}
      mark={brandMark()}
    />,
  );
  return new Uint8Array(buffer);
}
