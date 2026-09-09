/**
 * Extract plain text from uploaded workspace documents
 * (MD / DOCX / PDF / HTML.doc / Excel / CSV).
 */

import type { WorkspaceDocKind } from "@/types";

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const MAX_STORED_TEXT_CHARS = 80_000;
export const MAX_CONTEXT_CHARS = 24_000;
export const EXCERPT_CHARS = 500;

const ALLOWED_EXT = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".md",
  ".markdown",
  ".xlsx",
  ".xls",
  ".csv",
]);

const MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".xlsx":
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".csv": "text/csv",
};

export function extensionOf(filename: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(filename.trim());
  return m ? `.${m[1].toLowerCase()}` : "";
}

export function assertAllowedDocument(filename: string, sizeBytes: number): void {
  if (sizeBytes <= 0) throw new Error("File is empty.");
  if (sizeBytes > MAX_DOCUMENT_BYTES) {
    throw new Error("File is too large (max 10 MB).");
  }
  const ext = extensionOf(filename);
  if (!ALLOWED_EXT.has(ext)) {
    throw new Error(
      "Unsupported file type. Upload PDF, Word (.doc/.docx), Excel (.xlsx/.xls), CSV, or Markdown (.md).",
    );
  }
}

export function mimeForFilename(filename: string, fallback?: string): string {
  return MIME_BY_EXT[extensionOf(filename)] || fallback || "application/octet-stream";
}

export function inferDocKind(
  filename: string,
  text: string,
): WorkspaceDocKind {
  const hay = `${filename}\n${text.slice(0, 4000)}`.toLowerCase();
  if (
    /competitor|competitive|rival|ad library|vs\.|versus|benchmark/.test(hay)
  ) {
    return "competitor";
  }
  if (
    /framework|playbook|methodology|best practice|checklist|scoring|rubric/.test(
      hay,
    )
  ) {
    return "framework";
  }
  if (/brief|creative brief|campaign brief|brand guidelines|messaging/.test(hay)) {
    return "brief";
  }
  return "other";
}

export function truncateText(text: string, max: number): string {
  const cleaned = text.replace(/\u0000/g, "").replace(/\r\n/g, "\n").trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max)}\n\n…[truncated]`;
}

export function makeExcerpt(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= EXCERPT_CHARS) return oneLine;
  return `${oneLine.slice(0, EXCERPT_CHARS - 1)}…`;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

async function extractPdf(buffer: Buffer): Promise<string> {
  const { extractText } = await import("unpdf");
  const { text } = await extractText(new Uint8Array(buffer), {
    mergePages: true,
  });
  if (Array.isArray(text)) return text.join("\n\n");
  return String(text ?? "");
}

async function extractDocx(buffer: Buffer): Promise<string> {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ buffer });
  return result.value || "";
}

/** Legacy .doc may be real OLE Word or HTML Word export from our app. */
async function extractDoc(buffer: Buffer): Promise<string> {
  const asUtf8 = buffer.toString("utf8");
  if (/<html[\s>]/i.test(asUtf8) || /<w:WordDocument/i.test(asUtf8)) {
    return stripHtml(asUtf8);
  }
  try {
    return await extractDocx(buffer);
  } catch {
    throw new Error(
      "Could not read this .doc file. Re-save as .docx or PDF and upload again.",
    );
  }
}

/** Spreadsheet → readable sheet sections for the agent (all sheets). */
async function extractSpreadsheet(buffer: Buffer): Promise<string> {
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  if (!workbook.SheetNames.length) {
    throw new Error("Excel file has no sheets.");
  }

  const parts: string[] = [];
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false }).trim();
    if (!csv) continue;
    parts.push(`## Sheet: ${name}\n${csv}`);
  }

  if (!parts.length) {
    throw new Error("Excel file has no readable cells.");
  }
  return parts.join("\n\n");
}

export type ExtractedDocument = {
  text: string;
  kind: WorkspaceDocKind;
  mimeType: string;
};

export async function extractDocumentText(input: {
  filename: string;
  buffer: Buffer;
  mimeType?: string;
}): Promise<ExtractedDocument> {
  assertAllowedDocument(input.filename, input.buffer.byteLength);
  const ext = extensionOf(input.filename);
  let raw = "";

  if (ext === ".md" || ext === ".markdown") {
    raw = input.buffer.toString("utf8");
  } else if (ext === ".pdf") {
    raw = await extractPdf(input.buffer);
  } else if (ext === ".docx") {
    raw = await extractDocx(input.buffer);
  } else if (ext === ".doc") {
    raw = await extractDoc(input.buffer);
  } else if (ext === ".xlsx" || ext === ".xls" || ext === ".csv") {
    raw = await extractSpreadsheet(input.buffer);
  } else {
    throw new Error("Unsupported file type.");
  }

  const text = truncateText(raw, MAX_STORED_TEXT_CHARS);
  if (!text || text.length < 20) {
    throw new Error(
      "No readable text found in this file. Scanned PDFs without OCR are not supported yet.",
    );
  }

  return {
    text,
    kind: inferDocKind(input.filename, text),
    mimeType: mimeForFilename(input.filename, input.mimeType),
  };
}
