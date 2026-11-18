import { spokenBlocks, type SpokenBlock } from "@/lib/video/spoken-blocks";
import { splitLongLine } from "@/lib/video/timing";

/**
 * Read a script into scenes WITHOUT a model. This is the safety net under the language-model reader: when the model
 * is down, over its limits, or returns something that does not fit, whatever the operator typed is still turned into
 * scenes the system understands, with every spoken word kept exactly. Pure.
 *
 * It understands scripts that head their scenes ("SCENE 3 — TITLE", "[SCENE 2 - desk]", "[PROBLEM]"), label who speaks
 * ("VO:", "Dialogue — Founder:", `HR Manager: "..."`), label their directions ("Visual direction:", "Camera direction:",
 * "Sound:"), and add notes after the scenes ("Characters", "Cinematography"). Plain prose with no labels becomes
 * voiceover scenes at sentence ends.
 */

export type StructuredScene = {
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

export type Structured = {
  title: string;
  angle_name: string;
  pain: string;
  structure: string;
  style: string;
  character: string | null;
  setting: string;
  hook_alternatives: string[];
  scenes: StructuredScene[];
};

const SCENE_HEADING = /^\s*(?:#{1,4}\s*)?(?:\[\s*)?(?:scene|shot|beat|part|section)\s*#?\s*\d+\b.*$/i;
/** "[PROBLEM]" and "[SOLUTION]" style headings; a "[PLACEHOLDER: ...]" is not one. */
const BRACKET_HEADING = /^\s*\[[A-Za-z0-9][^\]:]{0,60}\]\s*$/;
const NOTES_HEADING = /^\s*(?:\d+[.)]\s*)?(characters?|cinematography|voiceover and audio|audio|important production requirements|production requirements|production notes|overall storytelling flow|style|look and feel|general instructions|ai video generation instructions)\s*:?\s*$/i;
/** A numbered or all-capitals line on its own ("3. AI VIDEO GENERATION INSTRUCTIONS") closes the scenes. */
const MAJOR_HEADING = /^\s*(?:\d+[.)]\s+)[A-Z][A-Z0-9 &/,'’–—-]{8,}\s*$/;
const FIELD = /^\s*(?:[-*•]\s*)?(visual direction|visuals?|camera direction|camera|acting direction|acting|sound|music|audio|sfx)\s*[:\-–—]\s*(.*)$/i;
const TITLE_LABEL = /^\s*title\s*[:\-–—]\s*(.+)$/i;

const isHeading = (l: string) => SCENE_HEADING.test(l) || BRACKET_HEADING.test(l);
const isClosing = (l: string) => NOTES_HEADING.test(l) || MAJOR_HEADING.test(l);

type Section = { heading: string; lines: string[] };

function fieldKey(label: string): "visual" | "camera" | "sound" | "acting" {
  const k = label.toLowerCase();
  if (k.startsWith("visual")) return "visual";
  if (k.startsWith("camera")) return "camera";
  if (k.startsWith("acting")) return "acting";
  return "sound";
}

const squash = (parts: string[]) => parts.map((p) => p.replace(/^\s*[-*•]\s*/, "").trim()).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

/** The text of each labelled direction in a stretch of lines, with the lines that belong to spoken parts left out. */
function directionsOf(lines: string[], skip: Set<number>): { visual: string; camera: string; sound: string; acting: string; loose: string } {
  const out: Record<"visual" | "camera" | "sound" | "acting", string[]> = { visual: [], camera: [], sound: [], acting: [] };
  const loose: string[] = [];
  let current: keyof typeof out | null = null;
  lines.forEach((raw, i) => {
    if (skip.has(i)) {
      current = null;
      return;
    }
    const f = FIELD.exec(raw);
    if (f) {
      current = fieldKey(f[1]!);
      if (f[2]!.trim()) out[current].push(f[2]!.trim());
      return;
    }
    if (!raw.trim()) return;
    if (current) out[current].push(raw.trim());
    else loose.push(raw.trim());
  });
  return { visual: squash(out.visual), camera: squash(out.camera), sound: squash(out.sound), acting: squash(out.acting), loose: squash(loose) };
}

/** Everything under a notes heading, up to the next one. */
function notesUnder(lines: string[], names: RegExp): string {
  const at = lines.findIndex((l) => NOTES_HEADING.test(l) && names.test(l));
  if (at < 0) return "";
  const body: string[] = [];
  for (let i = at + 1; i < lines.length; i += 1) {
    if (NOTES_HEADING.test(lines[i]!) || MAJOR_HEADING.test(lines[i]!)) break;
    body.push(lines[i]!);
  }
  return squash(body);
}

const GENERIC_VISUAL = "Show what is being said, in the same look as the scenes around it";
const GENERIC_CAMERA = "Medium shot, steady";
const SAME_SOUND = "Keeps the same music bed";

function sceneFor(block: SpokenBlock | null, visual: string, camera: string, sound: string, seconds = 4): StructuredScene {
  return { line: block?.text ?? "", speaker: block ? block.speaker : "none", visual, camera, keywords: [], stat: null, asset_id: null, sound, seconds };
}

/** Split a script into scenes by its own labels, or at sentence ends when it has none. */
export function structureByRules(scriptText: string): Structured {
  const lines = scriptText.split(/\r?\n/);

  // Where the scenes stop and the notes (characters, cinematography) begin.
  const firstHeading = lines.findIndex(isHeading);
  let scenesEnd = lines.length;
  for (let i = Math.max(firstHeading, 0) + 1; i < lines.length; i += 1) {
    if (isClosing(lines[i]!)) {
      scenesEnd = i;
      break;
    }
  }
  const notes = lines.slice(scenesEnd);
  const preamble = firstHeading > 0 ? lines.slice(0, firstHeading) : [];

  // Sections: one per heading. A script with no headings is a single section.
  const sections: Section[] = [];
  if (firstHeading < 0) sections.push({ heading: "", lines: lines.slice(0, scenesEnd) });
  else {
    for (let i = firstHeading; i < scenesEnd; i += 1) {
      if (isHeading(lines[i]!)) sections.push({ heading: lines[i]!.trim().replace(/^[#\s[]+|[\]\s]+$/g, ""), lines: [] });
      else sections.at(-1)!.lines.push(lines[i]!);
    }
  }

  const scenes: StructuredScene[] = [];
  const speakers = new Set<string>();
  for (const section of sections) {
    const blocks = spokenBlocks(section.lines.join("\n"));
    const skip = new Set<number>();
    for (const b of blocks) for (let k = b.startLine ?? 0; k <= (b.endLine ?? 0); k += 1) skip.add(k);
    const d = directionsOf(section.lines, skip);
    const heading = section.heading.replace(/^(?:scene|shot|beat|part|section)\s*#?\s*\d+\s*[:\-–—.]?\s*/i, "").trim();
    const visualAll = squash([d.visual, d.acting ? `Acting: ${d.acting}` : "", d.visual ? "" : d.loose]) || (heading ? `The scene: ${heading}` : "");
    const camera = d.camera || GENERIC_CAMERA;
    const sound = d.sound || SAME_SOUND;
    if (!blocks.length) {
      // A beat with nothing said in it: a silent scene that shows what the script describes.
      if (visualAll || heading) scenes.push(sceneFor(null, clip(visualAll || heading, 1200), camera, sound));
      continue;
    }
    const perBlock = sections.length === 1 && blocks.length > 1;
    blocks.forEach((b, k) => {
      if (b.name) speakers.add(b.name);
      const who = b.name && !/^(narrat|vo|voice)/i.test(b.name.replace(/\s/g, "")) ? `${b.name} speaks. ` : "";
      const own = perBlock ? b.visual : null;
      const visual = k === 0 ? `${who}${clip(own || visualAll || GENERIC_VISUAL, 1200)}` : `${who}${own ? clip(own, 600) : `Same scene as the shot before. ${clip(visualAll || GENERIC_VISUAL, 220)}`}`;
      scenes.push(sceneFor(b, visual, k === 0 ? camera : "Cut to the speaker; the same place and look as the shot before", k === 0 ? sound : SAME_SOUND));
    });
  }

  // No labels and nothing found: the words themselves, split at sentence ends, as a voiceover.
  if (!scenes.some((s) => s.line)) {
    const prose = lines
      .filter((l) => l.trim() && !isHeading(l) && !FIELD.test(l) && !TITLE_LABEL.test(l))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    scenes.length = 0;
    for (const piece of splitLongLine(prose, 8)) scenes.push({ line: piece, speaker: "voiceover", visual: GENERIC_VISUAL, camera: GENERIC_CAMERA, keywords: [], stat: null, asset_id: null, sound: SAME_SOUND, seconds: 4 });
  }

  const titleLine = lines.map((l) => TITLE_LABEL.exec(l)?.[1]?.trim()).find(Boolean);
  const firstPreamble = preamble.map((l) => l.trim()).find((l) => l && l.length <= 90 && !FIELD.test(l));
  const title = clip(titleLine || firstPreamble || sections[0]?.heading || "Your script", 80);

  const character = notesUnder(notes, /character/i) || (speakers.size ? [...speakers].join(", ") : "");
  const style = notesUnder(notes, /cinematograph|style|look/i) || "Realistic, natural light, in the look the script describes";
  const spoken = scenes.filter((s) => s.line).map((s) => s.line);
  const hooks = [...new Set(spoken)].slice(0, 3);
  while (hooks.length < 3) hooks.push(hooks[0] ?? title);

  return {
    title,
    angle_name: clip(title, 60),
    pain: "As the script sets out",
    structure: sections.length > 1 ? "Scene by scene, as the script is written" : "A single flow, as the script is written",
    style: clip(style, 600),
    character: character ? clip(character, 900) : null,
    setting: clip(scenes[0]?.visual ?? "As described in the script's scenes", 240),
    hook_alternatives: hooks,
    scenes,
  };
}

