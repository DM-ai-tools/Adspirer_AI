/**
 * Lightweight report exporters (Markdown / Word HTML / simple text PDF).
 * No heavy native deps — suitable for operator downloads from chat.
 */

export type ReportFormat = "md" | "docx" | "pdf";

function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "adspirer-report"
  );
}

export function buildReportFilename(title: string, format: ReportFormat): string {
  const base = slugify(title);
  if (format === "md") return `${base}.md`;
  if (format === "docx") return `${base}.doc`;
  return `${base}.pdf`;
}

export function exportMarkdown(title: string, body: string): string {
  return `# ${title}\n\n${body.trim()}\n`;
}

/** Word-compatible HTML (.doc) — opens cleanly in Word / Google Docs. */
export function exportWordHtml(title: string, body: string): string {
  const paragraphs = body
    .split(/\n{2,}/)
    .map((block) => {
      const html = escapeHtml(block).replace(/\n/g, "<br/>");
      return `<p>${html}</p>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:w="urn:schemas-microsoft-com:office:word"
      xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View></w:WordDocument></xml><![endif]-->
<style>
  body { font-family: Calibri, Arial, sans-serif; font-size: 11pt; line-height: 1.4; }
  h1 { font-size: 18pt; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${paragraphs}
</body>
</html>`;
}

/**
 * Minimal single-page text PDF (Helvetica) for operator downloads.
 */
export function exportSimplePdf(title: string, body: string): Uint8Array {
  const lines = wrapLines(`${title}\n\n${body}`, 90).slice(0, 60);
  const contentLines: string[] = ["BT", "/F1 11 Tf", "50 780 Td", "14 TL"];
  lines.forEach((line, index) => {
    const safe = pdfEscape(line);
    if (index === 0) contentLines.push(`(${safe}) Tj`);
    else contentLines.push(`T* (${safe}) Tj`);
  });
  contentLines.push("ET");
  const stream = contentLines.join("\n");

  const objects: string[] = [];
  objects.push("1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj");
  objects.push("2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj");
  objects.push(
    "3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>endobj",
  );
  objects.push(
    `4 0 obj<< /Length ${Buffer.byteLength(stream, "utf8")} >>stream\n${stream}\nendstream endobj`,
  );
  objects.push("5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj");

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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pdfEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function wrapLines(text: string, width: number): string[] {
  const out: string[] = [];
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    if (!raw.trim()) {
      out.push("");
      continue;
    }
    let line = raw;
    while (line.length > width) {
      let breakAt = line.lastIndexOf(" ", width);
      if (breakAt < 40) breakAt = width;
      out.push(line.slice(0, breakAt));
      line = line.slice(breakAt).trimStart();
    }
    out.push(line);
  }
  return out;
}
