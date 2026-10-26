/**
 * Read screenshots and image-only PDFs with a vision model, so they can sit in
 * the workspace documents like any other upload.
 */

import { getConfig } from "@/lib/config";

const VISION_PROMPT = [
  "This is a screenshot or image-only document the operator attached to an advertising workspace chat.",
  "Transcribe it so someone who cannot see it can rely on it:",
  "- Copy all visible text exactly, in reading order. Keep numbers, units, currencies, dates and names exactly as shown.",
  "- Then describe the layout in a few lines: which app or page it is (e.g. Meta Ads Manager, GA4, a landing page), table headers with their rows, charts and what they show, selected filters and date ranges.",
  "- Mark anything unreadable as [unreadable]. Never guess or fill in values that are not visible.",
  "Output only the transcription and description.",
].join("\n");

export const VISION_NOTE =
  "[Transcribed from an attached image by a vision model. Operator-provided, not verified against live data; a misread is possible.]";

export type VisualKind = "image" | "pdf";

export async function transcribeVisual(input: {
  buffer: Buffer;
  mimeType: string;
  kind: VisualKind;
}): Promise<string> {
  const config = getConfig();
  const { generateText } = await import("ai");
  const bytes = new Uint8Array(input.buffer);
  const part =
    input.kind === "pdf"
      ? ({ type: "file", data: bytes, mediaType: "application/pdf" } as const)
      : ({ type: "image", image: bytes, mediaType: input.mimeType } as const);

  const run = async (model: Parameters<typeof generateText>[0]["model"]) => {
    const { text } = await generateText({
      model,
      maxOutputTokens: 4000,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: VISION_PROMPT }, part],
        },
      ],
    });
    return text.trim();
  };

  const errors: string[] = [];
  if (config.ANTHROPIC_API_KEY) {
    try {
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      const anthropic = createAnthropic({ apiKey: config.ANTHROPIC_API_KEY });
      const text = await run(anthropic(config.ANTHROPIC_MODEL));
      if (text) return text;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (config.OPENAI_API_KEY) {
    try {
      const { createOpenAI } = await import("@ai-sdk/openai");
      const openai = createOpenAI({ apiKey: config.OPENAI_API_KEY });
      const text = await run(openai(config.OPENAI_MODEL));
      if (text) return text;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(
    errors.length
      ? "Couldn't read this image right now. Try again in a moment."
      : "Image reading isn't configured (no vision model key).",
  );
}
