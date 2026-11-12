/**
 * Clean video: the export is finished footage and sound only. Subtitles, logos, headlines, stat
 * badges, proof screenshots, call-to-action buttons and end cards are never drawn into it; they are
 * handed over separately (subtitle files, a transcript, a placement plan and the original files) for
 * the operator to add by hand.
 *
 * Turning the overlays off in the final render is not enough: a video model draws whatever its
 * prompt mentions. So the same rule is applied where the words are written: the plan, the clip
 * prompt and the narration. Pure helpers, client-safe.
 */

export type VideoMode = "clean" | "branded";

export type FinishingInput = { mode?: VideoMode; captions?: boolean; logo?: boolean; endCard?: boolean };
export type ResolvedFinishing = { mode: VideoMode; captions: boolean; logo: boolean; endCard: boolean };

/**
 * The finishing that actually applies. Clean is the default and switches every automatic graphic
 * off whatever else is stored or sent with it: a setting carried over from an older video can never
 * turn an overlay on in a clean export. Graphics are burned in only when "branded" is asked for by name.
 */
export function resolveFinishing(...layers: Array<FinishingInput | null | undefined>): ResolvedFinishing {
  // The mode comes from the most recent layer that names one; settings without a mode never choose it.
  const mode = [...layers].reverse().find((l) => l?.mode)?.mode ?? "clean";
  if (mode === "clean") return { mode: "clean", captions: false, logo: false, endCard: false };
  const merged = Object.assign({ captions: true, logo: true, endCard: true }, ...layers.filter(Boolean)) as ResolvedFinishing;
  return { mode: "branded", captions: Boolean(merged.captions), logo: Boolean(merged.logo), endCard: Boolean(merged.endCard) };
}

/** Which kind of export a stored video is. One made before clean video existed has no mode and had its graphics burned in. */
export function exportMode(final: { mode?: VideoMode | null } | null | undefined): VideoMode {
  return final?.mode === "clean" ? "clean" : "branded";
}

// ------------------------------------------------------------------ words that ask for a graphic

/**
 * Wording that describes something laid over the picture rather than something a camera films. Any
 * of it in a footage description makes the video model draw the graphic itself.
 */
const GRAPHIC_WORDS =
  /\b(overlays?|overlaid|composit\w*|insets?|captions?|subtitles?|lower[- ]thirds?|on[- ]screen (text|graphics?|words?|titles?)|keywords?|stat (cards?|badges?|overlays?)|stats? (appears?|shown|displayed)|cta\b|call[- ]to[- ]action (button|card|text|overlay)|end[- ]?cards?|title cards?|logos?|wordmarks?|watermarks?|badges?|headlines?|graphics?|banners?|text (appears?|reads?|says)|legible|dashboard asset|proof asset|screenshots?|asset\b|img_[A-Za-z0-9_-]+)\b/i;

const NEGATION = /\b(no|not|never|without|free of|avoid|none|nothing|zero)\b[^.;]{0,60}$/i;

/** The first graphic wording in a footage description, or null. A phrase that rules the graphic out ("no logos", "without captions") does not count. */
export function graphicReference(text: string): string | null {
  const re = new RegExp(GRAPHIC_WORDS.source, "gi");
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (!NEGATION.test(text.slice(Math.max(0, m.index - 70), m.index))) return m[0];
  }
  return null;
}

/** Only the lines that describe filmed footage: a check such as "the keyword appears as an overlay" is dropped. */
export function footageOnly(lines: string[]): string[] {
  return lines.filter((l) => l.trim() && !graphicReference(l));
}

/** A style or look sentence with any clause about graphics removed ("Presenter to camera with composited proof asset" becomes "Presenter to camera"). */
export function stripGraphicPhrases(text: string): string {
  if (!graphicReference(text)) return text.replace(/\s+/g, " ").trim();
  const kept = text
    .split(/\s*(?:[,;]|\bwith\b|\band\b|\bover\b|\bplus\b)\s*/i)
    .map((part) => part.trim())
    .filter((part) => part && !graphicReference(part));
  return kept.join(", ").replace(/\s+/g, " ").trim();
}

// ------------------------------------------------------------------ narration that points at a picture

/** Wording that only makes sense with an image on screen. In a clean video nothing is on screen, so the sentence has to stand on its own. */
const POINTING =
  /\b(as (you can|you'll|we can) see( here| below| above| on (the |this |your )?screen)?|(as )?(shown|pictured|displayed|seen) (here|below|above|on (the |this |your )?screen|in (this|the) (screenshot|image|chart|graph|dashboard|picture))|you can see (here|it|this|that|them)|(look|looking) at (this|these|the) (screenshot|numbers?|dashboard|chart|graph|results?|figures?)|(this|these|that) (screenshot|dashboard|chart|graph)s?|on (the |this |your )screen|right here|here(?:'s| is| are) (the|a|our) (screenshot|dashboard|chart|graph|proof))\b/i;

/** The part of a spoken line that points at something on screen, or null. */
export function pointingPhrase(line: string): string | null {
  return POINTING.exec(line)?.[0] ?? null;
}

const FIGURE = /[$€£]?\d[\d,.]*\s?(?:%|[kKmMbB]\b|\+|x\b)*/g;
const figuresOf = (text: string) => (text.match(FIGURE) ?? []).map((f) => f.replace(/[\s,]/g, "").replace(/[.]+$/, "").toLowerCase()).filter((f) => /\d/.test(f));

/**
 * The simple case, handled without a model: the pointing words are cut out and the sentence tidied
 * ("In the results shown here, that process delivered X" becomes "In the results, that process
 * delivered X"). Returns null when cutting leaves no usable sentence.
 */
export function cutPointingPhrase(line: string): string | null {
  let out = line;
  for (let i = 0; i < 4; i += 1) {
    const m = POINTING.exec(out);
    if (!m) break;
    const startsSentence = /(^|[.!?]\s+)$/.test(out.slice(0, m.index));
    let rest = out.slice(m.index + m[0].length);
    if (startsSentence) rest = rest.replace(/^\s*[,:;-]?\s*/, "").replace(/^[a-z]/, (c) => c.toUpperCase());
    out = `${out.slice(0, m.index)}${rest}`;
  }
  out = out.replace(/\s+([,.!?;:])/g, "$1").replace(/,\s*,/g, ",").replace(/\s{2,}/g, " ").trim();
  return acceptableStandalone(line, out) ? out : null;
}

/** A rewritten line may replace the original only when it no longer points at the screen, keeps every figure and stays about the same length. */
export function acceptableStandalone(original: string, rewritten: string): boolean {
  const text = rewritten.trim();
  if (!text || pointingPhrase(text)) return false;
  const want = figuresOf(original);
  const have = new Set(figuresOf(text));
  if (want.some((f) => !have.has(f)) || have.size !== new Set(want).size) return false;
  const a = original.trim().split(/\s+/).length;
  const b = text.split(/\s+/).length;
  if (b < 3 || b > Math.ceil(a * 1.25) + 1 || b < Math.floor(a * 0.4)) return false;
  return /[a-z]/i.test(text);
}

// ------------------------------------------------------------------ the rules given to the models

/** What the planner is told about a clean video. */
export const CLEAN_PLAN_RULES = [
  "THIS IS A CLEAN VIDEO. The footage and its sound are the whole finished video. Nothing is added to the picture afterwards by this application: no subtitles, captions, highlighted words, logos, headlines, statistic badges, call-to-action buttons, web addresses, screenshots or end cards. A person may add some of those by hand later, working from separate notes.",
  "So every scene's subject, setting, action, framing, camera, lighting, style, exit and acceptance checks describe ONLY what a camera films: people, places, objects, movement and light. They must never mention an overlay, a composite, an inset, a caption, a keyword, a stat, a graphic, a logo, a button, an asset, a screenshot or text appearing. The video model draws anything those fields mention.",
  "requiredAssets and overlays must be empty lists, and screenTreatment is footage_without_screen (or none when the scene has nothing to do with a screen or a result). The uploaded images are evidence for the claims: they are never shown, recreated, imitated or described to the video model.",
  "Suggestions for the person who finishes the video by hand go in editingNotes and nowhere else: at most two per scene, only where a graphic would genuinely add emphasis (not every spoken sentence), each with its exact wording and where it could sit. editingNotes are never sent to the video model.",
  "The spoken lines are speech. They are heard, never displayed: do not turn dialogue into a description of words on screen.",
  "Where it suits the shot, compose a calm, uncluttered area of the frame that could later hold a hand-placed graphic, without making the shot look empty or the person awkwardly off to one side.",
  "The last scene is the ending of the film itself, because no end card follows it. A person speaking finishes the final words, then holds a composed, relaxed expression for a brief natural pause; another style closes on a visual that completes the story. Never end mid-word, on a frozen face or on an abrupt change of picture, and never fill the ending with the company name as text or a placeholder graphic.",
  "Avoid long static shots: every shot has a small, believable physical action (a shift of weight, a glance, a hand resting, a step) and a camera that is either still for a reason or moving slowly for one.",
];

/** The line a clean clip prompt carries instead of "graphics are added afterwards". */
export const CLEAN_FOOTAGE_RULE =
  "This footage is the finished picture: nothing is added to it afterwards. Film only the people, places and objects described. The spoken words are heard, never shown: do not draw subtitles, captions, titles, highlighted words, numbers, charts, dashboards, screens with content, logos, brand names, buttons, web addresses or watermarks anywhere in the frame.";

export const CLEAN_ENDING_RULE =
  "This is the end of the film. After the last spoken word the person closes their mouth, holds a relaxed, composed expression and looks at the camera for about one second while the shot stays alive (breathing, a small natural movement). The clip does not end mid-word, on a frozen face, or on a cut to a card, text or logo.";
