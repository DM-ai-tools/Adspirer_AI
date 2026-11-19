import { formatPromptRule, type ImageFormat } from "@/lib/creatives/formats";
import type { PrintLine } from "@/lib/creatives/directed/markers";

/**
 * The prompt for an image the operator directed. It is deliberately not the brand-art-director prompt:
 * that one adds its own agency style and invents the look. Here the operator's picture instruction and
 * printed words are the brief, and the brand only fills in what the instruction leaves open.
 */
export function buildDirectedImagePrompt(input: {
  picture: string;
  print: PrintLine[];
  format: ImageFormat;
  colors?: string[] | null;
  hasLogo: boolean;
  tweak?: string;
  revisionNotes?: string | null;
}): string {
  const lines = input.print.filter((l) => l.text.trim());
  const palette = (input.colors ?? []).filter(Boolean).slice(0, 4);
  return [
    "Create ONE image for a Meta (Facebook/Instagram) ad, exactly as directed below. Follow the picture instruction literally: draw what it says, in the style, colours, setting and layout it names, and do not add subjects, props or ideas it does not ask for.",
    `PICTURE INSTRUCTION: ${input.picture.trim()}`,
    lines.length
      ? [
          "WORDS TO PRINT ON THE IMAGE: set exactly these words, spelled exactly as written (same spelling, capitals, punctuation and numbers), as clear, legible, well-sized typography placed as the picture instruction says (or where it reads best if it does not say). Role names are only for your guidance and are never printed.",
          ...lines.map((l) => `- ${l.role ? `${l.role}: ` : ""}"${l.text.trim()}"`),
          "Print no other words anywhere: no extra slogans, labels, lorem ipsum, gibberish, fake interface text or watermarks.",
        ].join("\n")
      : "Print no words anywhere on the image: no text, letters, numbers, captions or watermarks.",
    palette.length
      ? `Brand colours (use them only for what the picture instruction does not specify; if the instruction names its own colours, those override these): ${palette.join(", ")}.`
      : null,
    input.hasLogo ? "The brand logo is added afterwards, so do not draw any logo or brand mark; leave one corner calm and uncluttered for it." : null,
    "Photographic or illustrative detail is clean and believable: anatomically correct hands and faces, no distorted objects.",
    input.tweak ? `VARIATION: keep everything the same except: ${input.tweak}` : null,
    input.revisionNotes ? `Operator revision request: ${input.revisionNotes}` : null,
    formatPromptRule(input.format),
  ]
    .filter(Boolean)
    .join("\n");
}
