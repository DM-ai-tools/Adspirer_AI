import { generateObject } from "ai";
import { z } from "zod";
import type { WorkspaceDocument } from "@/types";
import { pickModel } from "@/lib/creatives/concept-writer";
import { logger } from "@/lib/observability/logger";

/**
 * What an uploaded ad copy or landing page file gives image creation: the post
 * copy to illustrate, the page it points to, and what the page offers.
 */
export type CreativeSource = {
  headline?: string;
  primaryText?: string;
  cta?: string;
  landingPageUrl?: string;
  /** What the uploaded landing page says it offers (for art direction). */
  pageSummary?: string;
  /** Files the details came from, so the reply can say so. */
  sourceFiles: string[];
};

const PER_DOC_CHARS = 5_000;
const MAX_DOCS = 4;

/** Files attached to this chat come first; otherwise the newest few of the client's library. */
export function pickSourceDocuments(docs: WorkspaceDocument[], conversationId?: string | null): WorkspaceDocument[] {
  const readable = docs.filter((d) => (d.extracted_text || d.excerpt || "").trim().length > 20);
  const attached = conversationId ? readable.filter((d) => d.conversation_id === conversationId) : [];
  return (attached.length ? attached : readable).slice(0, MAX_DOCS);
}

const sourceSchema = z.object({
  headline: z.string().nullable().describe("The ad headline exactly as written in an ad copy file, or null"),
  primary_text: z.string().nullable().describe("The ad's primary text / body exactly as written, or null"),
  cta: z.string().nullable().describe("The call to action wording if the copy file states one, or null"),
  landing_page_url: z.string().nullable().describe("The landing page URL stated in a file, or null"),
  landing_page_summary: z
    .string()
    .nullable()
    .describe("Under 600 characters: what an uploaded landing page file offers and to whom, using only its own text, or null"),
  used_files: z.array(z.string()).describe("File names the details above came from"),
});

/**
 * Read the headline, primary text, landing page and offer out of the uploaded
 * files. Files that are neither ad copy nor a landing page (competitor research,
 * audits, spreadsheets) are ignored. Returns null when there is nothing usable.
 */
export async function extractCreativeSource(input: {
  docs: WorkspaceDocument[];
  conversationId?: string | null;
  request: string;
}): Promise<CreativeSource | null> {
  const docs = pickSourceDocuments(input.docs, input.conversationId);
  if (!docs.length) return null;
  const model = pickModel();
  if (!model) return null;

  const files = docs
    .map((d) => `=== FILE: ${d.filename} (${d.doc_kind}) ===\n${(d.extracted_text || d.excerpt || "").slice(0, PER_DOC_CHARS)}`)
    .join("\n\n");
  try {
    const { object } = await generateObject({
      model,
      schema: sourceSchema,
      temperature: 0,
      system:
        "You read files a marketer uploaded and pull out exactly what is needed to make ad images. Use only text that is in the files. Never invent, paraphrase or improve copy: quote it as written. A file that is not ad copy or a landing page (competitor research, an audit, a spreadsheet) contributes nothing.",
      prompt: [
        `The operator asked: "${input.request.slice(0, 600)}"`,
        "",
        "Files:",
        files,
        "",
        "Return the headline, primary text and CTA from an ad copy file, the landing page URL if a file states one, and a short summary of what an uploaded landing page file offers. Use null for anything the files do not contain.",
      ].join("\n"),
    });
    const clean = (v: string | null | undefined) => (v && v.trim() ? v.trim() : undefined);
    const source: CreativeSource = {
      headline: clean(object.headline),
      primaryText: clean(object.primary_text),
      cta: clean(object.cta),
      landingPageUrl: clean(object.landing_page_url),
      pageSummary: clean(object.landing_page_summary),
      sourceFiles: object.used_files.filter((f) => docs.some((d) => d.filename === f)),
    };
    return source.headline || source.primaryText || source.landingPageUrl || source.pageSummary ? source : null;
  } catch (error) {
    logger.warn("Could not read ad copy / landing page from uploaded files", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
