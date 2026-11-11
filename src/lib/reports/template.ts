import { presentBlocks } from "@/lib/reports/present";
import {
  type InlineSpan,
  type ReportBlock,
  parseMarkdownToBlocks,
  sanitizeReportText,
} from "@/lib/reports/parse-markdown";

/**
 * Traffic Radius brand colours (trafficradius.com.au), used by every exported report. Taken from the
 * logo's own pixels and the site's stylesheet: the logo's black is the main colour, lime the site's most-used
 * accent, sky the logo's other bar, charcoal its wordmark.
 */
export const REPORT_THEME = {
  dark: "#0C0D0D",
  darkSoft: "#4A4D55",
  /** Headings at small sizes: the logo's sky, darkened enough to read on white. */
  skyInk: "#15668F",
  sky: "#3EB8E7",
  skySoft: "#EAF6FC",
  lime: "#A4D36B",
  limeInk: "#5E8F2B",
  limeSoft: "#F1F8E8",
  black: "#0C0D0D",
  ink: "#2C2E35",
  muted: "#63666B",
  border: "#E1E3E6",
  surface: "#F6F7F8",
  white: "#FFFFFF",
  // The names the renderers used before, kept on the same brand.
  primary: "#0C0D0D",
  primaryDark: "#0C0D0D",
  primaryLight: "#F1F8E8",
  tableHeader: "#0C0D0D",
  accent: "#A4D36B",
} as const;

/** The logo for the HTML preview, served by the app from public/brand. */
const BRAND_LOGO_URL = "/brand/traffic-radius-logo.png";

/** The three bars of the logo, in order, for rules and tiles. */
export const BRAND_BARS = ["#0C0D0D", "#3EB8E7", "#A4D36B"] as const;

/** Card colours: the bar and tag colour, and the faint fill behind the card. Same in every format. */
export const CARD_TONES = {
  critical: { bar: "#DC2626", fill: "#FEF2F2", label: "Critical" },
  high: { bar: "#EA580C", fill: "#FFF7ED", label: "High" },
  medium: { bar: "#CA8A04", fill: "#FEFCE8", label: "Medium" },
  low: { bar: "#64748B", fill: "#F8FAFC", label: "Low" },
  action: { bar: "#3EB8E7", fill: "#EAF6FC", label: "Action" },
  positive: { bar: "#7DB544", fill: "#F1F8E8", label: "Justified" },
  negative: { bar: "#DC2626", fill: "#FEF2F2", label: "Wrong call" },
  neutral: { bar: "#94A3B8", fill: "#F8FAFC", label: "" },
} as const;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderSpansHtml(spans: InlineSpan[]): string {
  const parts: string[] = [];
  for (let i = 0; i < spans.length; i += 1) {
    const span = spans[i];
    const t = escapeHtml(span.text);
    let html = t;
    if (span.type === "bold") html = `<strong>${t}</strong>`;
    else if (span.type === "italic") html = `<em>${t}</em>`;
    else if (span.type === "code") {
      html = `<code style="background:${REPORT_THEME.surface};padding:1px 4px;border-radius:3px;font-size:10pt;">${t}</code>`;
    }
    if (parts.length) {
      const prev = spans[i - 1]?.text ?? "";
      const needsSpace =
        /[A-Za-z0-9)]$/.test(prev) &&
        /^[A-Za-z0-9(]/.test(span.text) &&
        !/\s$/.test(prev) &&
        !/^\s/.test(span.text);
      if (needsSpace) parts.push(" ");
    }
    parts.push(html);
  }
  return parts.join("");
}

function renderBlocksHtml(blocks: ReportBlock[]): string {
  return blocks
    .map((block) => {
      switch (block.type) {
        case "heading": {
          const tag = `h${block.level}` as "h1" | "h2" | "h3";
          return `<${tag}>${escapeHtml(block.text)}</${tag}>`;
        }
        case "paragraph":
          return `<p>${renderSpansHtml(block.spans)}</p>`;
        case "list": {
          const tag = block.ordered ? "ol" : "ul";
          const items = block.items
            .map((item) => `<li>${renderSpansHtml(item)}</li>`)
            .join("");
          return `<${tag}>${items}</${tag}>`;
        }
        case "table": {
          const head = block.headers
            .map((h) => `<th>${escapeHtml(h)}</th>`)
            .join("");
          const body = block.rows
            .map(
              (row, r) =>
                `<tr${block.strongRows?.includes(r) ? ' class="total"' : ""}>${row.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`,
            )
            .join("");
          return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
        }
        case "hr":
          return `<hr />`;
        case "kpis":
          return `<div class="kpis">${block.items.map((i) => `<div class="kpi"><div class="kpi-value">${escapeHtml(i.value)}</div><div class="kpi-label">${escapeHtml(i.label)}</div></div>`).join("")}</div>`;
        case "card": {
          const tone = CARD_TONES[block.tone];
          const fields = block.fields.map((f) => `<div class="field"><span class="field-label">${escapeHtml(f.label)}</span><span>${renderSpansHtml(f.value)}</span></div>`).join("");
          const notes = block.notes.map((n) => `<div class="field"><span class="field-label">•</span><span>${renderSpansHtml(n)}</span></div>`).join("");
          return `<div class="card" style="border-left-color:${tone.bar};background:${tone.fill}"><div class="card-head">${block.tag ? `<span class="tag" style="background:${tone.bar}">${escapeHtml(block.tag)}</span>` : ""}<strong>${escapeHtml(block.title)}</strong></div>${fields}${notes}</div>`;
        }
        case "note":
          return `<p class="${block.kind === "read" ? "read" : "footnote"}">${renderSpansHtml(block.spans)}</p>`;
        default:
          return "";
      }
    })
    .join("\n");
}

export function renderReportHtml(input: {
  title: string;
  markdown: string;
  subtitle?: string;
  generatedAt?: Date;
}): string {
  const title = sanitizeReportText(input.title);
  const generatedAt = input.generatedAt ?? new Date();
  const dateLabel = generatedAt.toLocaleString("en-AU", {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const subtitle =
    input.subtitle?.trim() ||
    "Meta Ads report · Prepared by Traffic Radius";

  let blocks = presentBlocks(parseMarkdownToBlocks(input.markdown));
  // Drop duplicate H1 if it matches the document title
  if (
    blocks[0]?.type === "heading" &&
    blocks[0].level === 1 &&
    blocks[0].text.toLowerCase() === title.toLowerCase()
  ) {
    blocks = blocks.slice(1);
  }

  const body = renderBlocksHtml(blocks);
  const t = REPORT_THEME;

  return `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:w="urn:schemas-microsoft-com:office:word"
      xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->
<style>
  @page { margin: 1.6cm 1.8cm; }
  body {
    font-family: Montserrat, Calibri, "Segoe UI", Arial, sans-serif;
    font-size: 11pt;
    line-height: 1.55;
    color: ${t.ink};
    margin: 0;
    padding: 0;
  }
  .cover-top { display: flex; justify-content: space-between; align-items: flex-end; padding: 0 0 14px; }
  .cover-top .kind { text-align: right; font-size: 8pt; font-weight: 700; letter-spacing: .16em; color: ${t.dark}; }
  .cover-top .kind span { display: block; font-weight: 400; letter-spacing: 0; color: ${t.muted}; }
  .band { display: flex; height: 5px; }
  .band span { flex: 1; }
  .cover {
    background: ${t.dark};
    color: ${t.white};
    padding: 28px 32px 24px;
    margin: 0 0 28px 0;
  }
  .cover .brand {
    font-size: 9pt;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: ${t.lime};
    font-weight: 700;
    margin: 0 0 10px 0;
  }
  .cover h1 {
    font-size: 22pt;
    margin: 0 0 8px 0;
    font-weight: 700;
    line-height: 1.25;
    color: ${t.white};
    border: none;
    padding: 0;
  }
  .cover .meta {
    font-size: 10pt;
    opacity: 0.92;
    margin: 0;
  }
  .content { padding: 0 8px 24px; }
  h1 {
    font-size: 18pt;
    color: ${t.dark};
    margin: 22px 0 10px;
    padding-bottom: 6px;
    border-bottom: 2px solid ${t.lime};
  }
  h2 {
    font-size: 13.5pt;
    color: ${t.white};
    background: ${t.dark};
    border-left: 5px solid ${t.lime};
    margin: 22px 0 10px;
    padding: 6px 10px;
  }
  h3 {
    font-size: 11.5pt;
    color: ${t.skyInk};
    margin: 16px 0 6px;
  }
  p { margin: 0 0 10px 0; text-align: left; }
  ul, ol { margin: 0 0 12px 1.2em; padding: 0; text-align: left; }
  li { margin: 0 0 6px 0; text-align: left; line-height: 1.5; }
  strong { color: ${t.ink}; }
  td, th { text-align: left; }
  hr {
    border: none;
    border-top: 1px solid ${t.border};
    margin: 18px 0;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    margin: 10px 0 16px;
    font-size: 10pt;
  }
  th {
    background: ${t.dark};
    color: ${t.white};
    text-align: left;
    padding: 8px 10px;
    border: 1px solid ${t.border};
    font-weight: 700;
  }
  td {
    padding: 7px 10px;
    border: 1px solid ${t.border};
    vertical-align: top;
  }
  tr:nth-child(even) td { background: ${t.surface}; }
  .footer {
    margin-top: 32px;
    padding-top: 12px;
    border-top: 2px solid ${t.lime};
    font-size: 9pt;
    color: ${t.muted};
  }
  tr.total td { font-weight: 700; background: ${t.limeSoft}; color: ${t.dark}; border-top: 2px solid ${t.lime}; }
  .kpis { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 12px; }
  .kpi { flex: 1 1 22%; border: 1px solid ${t.border}; border-top: 3px solid ${t.dark}; background: ${t.white}; padding: 7px 9px; }
  .kpi:nth-child(3n+2) { border-top-color: ${t.sky}; }
  .kpi:nth-child(3n) { border-top-color: ${t.lime}; }
  .kpi-value { font-size: 14pt; font-weight: 700; color: ${t.dark}; }
  .kpi-label { font-size: 7.5pt; color: ${t.muted}; text-transform: uppercase; letter-spacing: .03em; }
  .card { border-left: 4px solid; padding: 8px 12px; margin: 0 0 9px; }
  .card-head { margin-bottom: 4px; }
  .tag { color: #fff; font-size: 8pt; font-weight: 700; padding: 1px 6px; margin-right: 7px; border-radius: 2px; }
  .field { display: flex; gap: 8px; font-size: 10pt; margin-top: 2px; }
  .field-label { flex: 0 0 110px; font-weight: 600; color: ${t.muted}; }
  .read { background: ${t.limeSoft}; border-left: 3px solid ${t.lime}; color: ${t.dark}; padding: 4px 9px; font-size: 10pt; margin-top: -6px; }
  .footnote { color: ${t.muted}; font-size: 8.5pt; }
</style>
</head>
<body>
  <div class="cover-top">
    <img src="${BRAND_LOGO_URL}" alt="Traffic Radius" height="44" />
    <p class="kind">${/audit/i.test(title) ? "META ADS AUDIT" : "META ADS REPORT"}<span>${escapeHtml(dateLabel)}</span></p>
  </div>
  <div class="band">${BRAND_BARS.map((c) => `<span style="background:${c}"></span>`).join("")}</div>
  <div class="cover">
    <p class="brand">Traffic Radius</p>
    <h1>${escapeHtml(title)}</h1>
    <p class="meta">${escapeHtml(subtitle)} · ${escapeHtml(dateLabel)}</p>
  </div>
  <div class="content">
    ${body}
    <div class="footer">
      <strong>Prepared by Traffic Radius</strong> · trafficradius.com.au · Confidential · ${escapeHtml(dateLabel)}
    </div>
  </div>
</body>
</html>`;
}
