/**
 * Which creative format (image or video) the operator asked for.
 *
 * Only their own words count. The chat cards compose messages ("Advanced
 * targeting selections:", "Campaign settings selections:") whose lines can
 * contain "reels" (a placement) or "Video games" (an interest); those must not
 * flip an image campaign to video.
 */

const SELECTION_MARKER = /^\s*(?:<!--.*?-->\s*)*(?:advanced targeting|campaign settings) selections:/i;

/** The text with the cards' composed selection blocks removed. */
export function stripSelectionBlocks(text: string): string {
  const kept: string[] = [];
  let inBlock = false;
  let inFence = false;
  for (const line of text.split("\n")) {
    if (SELECTION_MARKER.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock) {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence || line.trim() === "" || /^\s*-\s/.test(line)) continue;
      inBlock = false;
    }
    kept.push(line);
  }
  return kept.join("\n").replace(/<!--.*?-->/g, "");
}

export function detectCreativeFormat(request: string): "image" | "video" | null {
  const text = stripSelectionBlocks(request);
  if (/\b(video|reel|reels|mp4|mov)\b/i.test(text)) return "video";
  if (/\b(image|still|static|jpg|png|jpeg)\b/i.test(text)) return "image";
  return null;
}
