import { verbatimCheck, type Span } from "@/lib/video/verbatim";

/**
 * The spoken parts of a script that labels them ("VO:", "Presenter:" ...), found without a model, so
 * that a spoken line the analysis skipped can be put back instead of silently lost. Pure.
 */

export type SpokenBlock = {
  /** The words to be said, as written (quotation marks around them removed). */
  text: string;
  speaker: "voiceover" | "on_camera";
  /** The script's own visual direction that follows this line, if it gives one. */
  visual: string | null;
};

const SPOKEN_LABEL = /^\s*(?:[-*•]\s*)?(VO|V\.O\.|VOICE[ -]?OVER|NARRATOR|NARRATION|PRESENTER|SPEAKER|HOST|DIALOGUE|ON[ -]?CAMERA|CREATOR|FOUNDER)\s*[:\-–—]\s*(.*)$/i;
/** Any other "Label:" line (Visual Direction, Text Overlay, Uploaded Asset Placeholder ...) ends a spoken block. */
const ANY_LABEL = /^\s*(?:[-*•]\s*)?[A-Za-z][A-Za-z0-9 /&()'.-]{1,45}:(\s|$)/;
const VISUAL_LABEL = /^\s*(?:[-*•]\s*)?(?:VISUAL(?: DIRECTION)?|VISUALS|B-?ROLL|SHOT|SCENE)\s*[:\-–—]\s*(.*)$/i;
/** Labels of the other things a script puts beside its spoken line: these end a visual direction. */
const OTHER_LABEL = /^\s*(?:[-*•]\s*)?(?:TEXT OVERLAY|ON[- ]?SCREEN(?: TEXT)?|SUPER|CAPTION|UPLOADED ASSET|AI VISUAL|ASSET|PLACEHOLDER|SOUND|MUSIC|SFX|AUDIO|CAMERA|TRANSITION)\b/i;
const SECTION_HEADER = /^\s*(?:\[[^\]]{1,60}\]|#{1,4}\s.*|[-=*_]{3,})\s*$/;

/** Quotation marks around a whole line are not part of the words. */
function unquote(text: string): string {
  return text.trim().replace(/^[“”"‘’']+/, "").replace(/[“”"‘’']+$/, "").trim();
}

const isVoice = (label: string) => /^(VO|V\.O\.|VOICE|NARRAT)/i.test(label.replace(/\s/g, ""));

/** The labelled spoken blocks of a script, in order. */
export function spokenBlocks(script: string): SpokenBlock[] {
  const lines = script.split(/\r?\n/);
  const blocks: SpokenBlock[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = SPOKEN_LABEL.exec(lines[i]!);
    if (!m) continue;
    const parts = [m[2]!.trim()];
    let j = i + 1;
    // The block continues over plain lines until a blank line, a header or another label.
    for (; j < lines.length; j += 1) {
      const next = lines[j]!;
      if (!next.trim() || SECTION_HEADER.test(next) || ANY_LABEL.test(next)) break;
      parts.push(next.trim());
    }
    const text = unquote(parts.filter(Boolean).join(" "));
    // The script's own visual direction for this beat: the "Visual Direction:" that follows, up to the next block.
    let visual: string | null = null;
    for (let k = j; k < lines.length && k < j + 12; k += 1) {
      if (SPOKEN_LABEL.test(lines[k]!) || SECTION_HEADER.test(lines[k]!)) break;
      const v = VISUAL_LABEL.exec(lines[k]!);
      if (v) {
        const body = [v[1]!.trim()];
        for (let q = k + 1; q < lines.length; q += 1) {
          const l = lines[q]!;
          if (!l.trim() || SPOKEN_LABEL.test(l) || SECTION_HEADER.test(l) || OTHER_LABEL.test(l) || VISUAL_LABEL.test(l)) break;
          body.push(l.replace(/^\s*[-*•]\s*/, "").trim());
        }
        visual = body.filter(Boolean).join("; ").slice(0, 400) || null;
        break;
      }
    }
    if (text.split(/\s+/).filter(Boolean).length >= 2) blocks.push({ text, speaker: isVoice(m[1]!) ? "voiceover" : "on_camera", visual });
    i = j - 1;
  }
  return blocks;
}

export type RepairableScene = {
  line: string;
  speaker: "on_camera" | "voiceover" | "none";
  visual: string;
  camera: string;
  keywords: string[];
  stat: string | null;
  asset_id: string | null;
  sound: string;
  seconds: number;
};

/**
 * Put back the spoken lines of a labelled script that the analysis left out. A block counts as covered when
 * most of its words are in a scene's line; any other is added as a scene, in the place it has in the script,
 * with the script's own visual direction. Returns the new scenes, their lines and spans, and which scenes are new.
 */
export function restoreMissingSpeech<T extends RepairableScene>(
  script: string,
  scenes: T[],
  lines: string[],
  spans: Array<Span | null>,
): { scenes: T[]; lines: string[]; spans: Array<Span | null>; added: number[]; from: number[] } {
  const blocks = spokenBlocks(script);
  if (!blocks.length) return { scenes, lines, spans, added: [], from: scenes.map((_, i) => i) };
  const located = verbatimCheck(script, blocks.map((b) => b.text)).spans;

  const used = new Set<number>();
  for (const s of spans) if (s) for (let w = s.start; w <= s.end; w += 1) used.add(w);

  type Entry = { key: number; scene: T; line: string; span: Span | null; added: boolean; from: number };
  const entries: Entry[] = [];
  let lastEnd = -1;
  scenes.forEach((scene, i) => {
    const span = spans[i] ?? null;
    entries.push({ key: span ? span.start : lastEnd + 0.5, scene, line: lines[i]!, span, added: false, from: i });
    if (span) lastEnd = span.end;
  });

  const rawWords = script.trim().split(/\s+/).filter(Boolean);
  const hasWord = (w: number) => /[\p{L}\p{N}]/u.test(rawWords[w] ?? "");
  const textOf = (from: number, to: number) => rawWords.slice(from, to + 1).join(" ").replace(/^[“"]+\s*/, "").replace(/\s*[”"]+$/, "");

  blocks.forEach((block, i) => {
    const span = located[i];
    if (!span) return;
    // The stretches of this block that no scene carries (all of it when the whole part was skipped).
    const runs: Span[] = [];
    let open: Span | null = null;
    for (let w = span.start; w <= span.end; w += 1) {
      if (used.has(w)) {
        if (open) runs.push(open);
        open = null;
      } else if (!open) open = { start: w, end: w };
      else open.end = w;
    }
    if (open) runs.push(open);
    let first = true;
    for (const run of runs) {
      let count = 0;
      for (let w = run.start; w <= run.end; w += 1) if (hasWord(w)) count += 1;
      if (count < 2) continue;
      // A missing tail that follows a scene directly belongs to that scene: the sentence is not cut in two.
      const owner = entries.find((e) => !e.added && e.span && e.span.end < run.start && !Array.from({ length: run.start - e.span.end - 1 }, (_, k) => e.span!.end + 1 + k).some(hasWord));
      const ownerWords = owner?.span ? owner.span.end - owner.span.start + 1 : 0;
      if (owner?.span && ownerWords + (run.end - run.start + 1) <= 45) {
        owner.span = { start: owner.span.start, end: run.end };
        owner.line = textOf(owner.span.start, owner.span.end);
        for (let w = run.start; w <= run.end; w += 1) used.add(w);
        first = false;
        continue;
      }
      const scene = {
        line: textOf(run.start, run.end),
        speaker: block.speaker,
        visual: first && block.visual ? block.visual : "Show what is being said, in the same look as the scenes around it",
        camera: "Medium shot, steady",
        keywords: [],
        stat: null,
        asset_id: null,
        sound: "Keeps the same music bed",
        seconds: 4,
      } as unknown as T;
      entries.push({ key: run.start, scene, line: textOf(run.start, run.end), span: run, added: true, from: -1 });
      for (let w = run.start; w <= run.end; w += 1) used.add(w);
      first = false;
    }
  });

  entries.sort((a, b) => a.key - b.key);
  const added: number[] = [];
  entries.forEach((e, i) => {
    if (e.added) added.push(i + 1);
  });
  return { scenes: entries.map((e) => e.scene), lines: entries.map((e) => e.line), spans: entries.map((e) => e.span), added, from: entries.map((e) => e.from) };
}
