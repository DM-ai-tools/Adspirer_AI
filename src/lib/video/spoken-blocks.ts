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
  /** Who says it, when the script names them ("Founder", "HR Manager"). */
  name?: string | null;
  /** The first and last line of the script (0-based) this block occupies, its label included. */
  startLine?: number;
  endLine?: number;
};

/** Whether a line of the script opens a spoken part ("VO:", "Dialogue — Founder:", `HR Manager: "..."`). */
export function startsSpokenPart(lines: string[], i: number): boolean {
  return startOf(lines, i) !== null;
}

const SPOKEN_LABEL = /^\s*(?:[-*•]\s*)?(VO|V\.O\.|VOICE[ -]?OVER|NARRATOR|NARRATION|PRESENTER|SPEAKER|HOST|DIALOGUE|ON[ -]?CAMERA|CREATOR|FOUNDER)\s*[:\-–—]\s*(.*)$/i;
/** Any other "Label:" line (Visual Direction, Text Overlay, Uploaded Asset Placeholder ...) ends a spoken block. */
const ANY_LABEL = /^\s*(?:[-*•]\s*)?[A-Za-z][A-Za-z0-9 /&()'.–—-]{1,45}:(\s|$)/;
const VISUAL_LABEL = /^\s*(?:[-*•]\s*)?(?:VISUAL(?: DIRECTION)?|VISUALS|B-?ROLL|SHOT|SCENE)\s*[:\-–—]\s*(.*)$/i;
/** Labels of the other things a script puts beside its spoken line: these end a visual direction. */
const OTHER_LABEL = /^\s*(?:[-*•]\s*)?(?:TEXT OVERLAY|ON[- ]?SCREEN(?: TEXT)?|SUPER|CAPTION|UPLOADED ASSET|AI VISUAL|ASSET|PLACEHOLDER|SOUND|MUSIC|SFX|AUDIO|CAMERA|TRANSITION)\b/i;
const SECTION_HEADER = /^\s*(?:\[[^\]]{1,60}\]|#{1,4}\s.*|[-=*_]{3,})\s*$/;

/** Quotation marks around a whole line are not part of the words. */
function unquote(text: string): string {
  return text.trim().replace(/^[“”"‘’']+/, "").replace(/[“”"‘’']+$/, "").trim();
}

const isVoice = (label: string) => /^(VO|V\.O\.|VOICE|NARRAT|ANNOUNCER)/i.test(label.replace(/\s/g, ""));

/** Words a "Label:" can have when it is a direction or a heading and not a person speaking. */
const DIRECTION_NAME =
  /^(?:visuals?(?: direction)?|camera(?: direction)?|acting(?: direction)?|sound|music|sfx|audio|text overlay|on[- ]?screen(?: text)?|super|caption|transition|note|notes|title|scene|shot|flashback(?: [a-z])?|setting|location|cast|characters?|style|cinematography|production|important production requirements|voiceover and audio|overall storytelling flow|reveal|logo|asset|uploaded asset|ai visual|placeholder)\b/i;
/** A speaker's name: a short label, not a sentence. */
const NAME = /^[A-Za-z][A-Za-z .'&/()-]{0,40}$/;
const OPENS_QUOTE = /^[“"‘]/;
const CLOSES_QUOTE = /[”"’][.!?]?\s*$/;

type Start = { name: string | null; speaker: "voiceover" | "on_camera"; rest: string };

/** Whether this line begins a spoken part, and who says it. The next non-empty line is looked at for "Name:" followed by the words on their own line. */
function startOf(lines: string[], i: number): Start | null {
  const line = lines[i]!;
  const known = SPOKEN_LABEL.exec(line);
  if (known) {
    const rest = known[2]!.trim();
    // "Dialogue — Founder: ..." names who speaks.
    const named = /^dialogue$/i.test(known[1]!.trim()) ? /^([A-Za-z][A-Za-z .'&/()-]{0,40}):\s*(.*)$/.exec(rest) : null;
    if (named) return { name: named[1]!.trim(), speaker: isVoice(named[1]!) ? "voiceover" : "on_camera", rest: named[2]!.trim() };
    return { name: /^(narrat|vo|v\.o|voice)/i.test(known[1]!.replace(/\s/g, "")) ? null : known[1]!.trim(), speaker: isVoice(known[1]!) ? "voiceover" : "on_camera", rest };
  }
  // "Closing voiceover:", "Opening voiceover:", "Final VO:"
  const framed = /^\s*(?:[-*•]\s*)?(?:closing|opening|final|end|intro|outro)\s+(?:voice[ -]?over|vo|v\.o\.|narration)\s*[:\-–—]\s*(.*)$/i.exec(line);
  if (framed) return { name: null, speaker: "voiceover", rest: framed[1]!.trim() };
  // "Dialogue — HR Manager:" with the words below
  const dialogue = /^\s*(?:[-*•]\s*)?dialogue\s*[—–-]\s*([^:]{1,40}):\s*(.*)$/i.exec(line);
  if (dialogue) return { name: dialogue[1]!.trim(), speaker: isVoice(dialogue[1]!) ? "voiceover" : "on_camera", rest: dialogue[2]!.trim() };
  // "HR Manager: "words"" or "HR Manager:" with a quoted line next
  const named = /^\s*(?:[-*•]\s*)?([^:]{1,41}):\s*(.*)$/.exec(line);
  if (named && NAME.test(named[1]!.trim()) && !DIRECTION_NAME.test(named[1]!.trim())) {
    const rest = named[2]!.trim();
    let next = "";
    for (let k = i + 1; k < lines.length; k += 1) {
      if (lines[k]!.trim()) {
        next = lines[k]!.trim();
        break;
      }
    }
    if (OPENS_QUOTE.test(rest) || (!rest && OPENS_QUOTE.test(next))) {
      const name = named[1]!.trim();
      return { name, speaker: isVoice(name) ? "voiceover" : "on_camera", rest };
    }
  }
  return null;
}

/** The labelled spoken blocks of a script, in order. */
export function spokenBlocks(script: string): SpokenBlock[] {
  const lines = script.split(/\r?\n/);
  const blocks: SpokenBlock[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = startOf(lines, i);
    if (!m) continue;
    const parts = [m.rest];
    let j = i + 1;
    // Words in quotes end where the quote closes; unquoted words continue over plain lines until a blank line, a header or another label.
    let closed = OPENS_QUOTE.test(m.rest) && CLOSES_QUOTE.test(m.rest) && m.rest.length > 1;
    for (; j < lines.length && !closed; j += 1) {
      const next = lines[j]!;
      if (!next.trim()) {
        // a quoted line may follow a blank line after its label
        if (!parts.some(Boolean) && lines.slice(j + 1).find((l) => l.trim())?.trim().match(OPENS_QUOTE)) continue;
        break;
      }
      if (SECTION_HEADER.test(next) || ANY_LABEL.test(next) || startOf(lines, j)) break;
      parts.push(next.trim());
      if (OPENS_QUOTE.test(parts.filter(Boolean)[0] ?? "") && CLOSES_QUOTE.test(next.trim())) {
        j += 1;
        break;
      }
    }
    const text = unquote(parts.filter(Boolean).join(" "));
    // The script's own visual direction for this beat: the "Visual Direction:" that follows, up to the next block.
    let visual: string | null = null;
    for (let k = j; k < lines.length && k < j + 12; k += 1) {
      if (startOf(lines, k) || SECTION_HEADER.test(lines[k]!)) break;
      const v = VISUAL_LABEL.exec(lines[k]!);
      if (v) {
        const body = [v[1]!.trim()];
        for (let q = k + 1; q < lines.length; q += 1) {
          const l = lines[q]!;
          if (!l.trim() || startOf(lines, q) || SECTION_HEADER.test(l) || OTHER_LABEL.test(l) || VISUAL_LABEL.test(l)) break;
          body.push(l.replace(/^\s*[-*•]\s*/, "").trim());
        }
        visual = body.filter(Boolean).join("; ").slice(0, 400) || null;
        break;
      }
    }
    if (text.split(/\s+/).filter(Boolean).length >= 1 && text.replace(/[^\p{L}\p{N}]/gu, "").length >= 2) blocks.push({ text, speaker: m.speaker, visual, name: m.name, startLine: i, endLine: j - 1 });
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
