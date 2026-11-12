import { mmss } from "@/lib/video/overlays";
import { actionRuleFor, classifyStyle, clipVisual, REALISM_RULE, STYLE_LOOKS, TEXT_FREE_RULE, wantsRealism } from "@/lib/video/visual-rules";
import { CLEAN_ENDING_RULE, CLEAN_FOOTAGE_RULE, footageOnly, graphicReference, stripGraphicPhrases } from "@/lib/video/clean-mode";
import type { VideoScene, VideoScript } from "@/lib/video/script";
import type { PlanCharacter, PlanEnvironment, SceneBrief } from "@/lib/video/pipeline-types";

/**
 * The prompt for one clip, built the way the Seedance prompt guides ask for: assets named by type
 * and number, a one-sentence summary, details that must stay constant, then a timed shot list with
 * the exact words spoken. Words, numbers, logos and captions are NOT asked of the model (it draws
 * text badly): they are added afterwards, exactly.
 */

export type ClipPromptInput = {
  script: Pick<VideoScript, "style" | "character" | "setting" | "scenes">;
  /** The scenes in this clip, in order. */
  sceneNumbers: number[];
  clipNumber: number;
  clipCount: number;
  locale: string;
  /** Which reference assets this request carries, so the prompt can name them. */
  refs: { presenter: boolean; location: boolean; previousFrame: boolean; previousVideo: boolean };
  /** Lines that were also given a graphic in post (a stat or an uploaded image). */
  graphicSceneNumbers: number[];
};

const ACCENT: Record<string, string> = {
  "en-au": "an Australian English accent",
  "en-us": "an American English accent",
  "en-gb": "a British English accent",
  "en-nz": "a New Zealand English accent",
};

export function accentFor(locale: string): string {
  return ACCENT[locale.toLowerCase()] ?? "a natural accent";
}

function shot(scene: VideoScene, offset: number, graphic: boolean, hasPresenter: boolean, hasCharacter: boolean): string {
  const start = offset;
  const end = offset + scene.seconds;
  const range = `${start}s-${end}s`;
  // A shot that is mainly a screen is filmed as the person's reaction: the model would draw the screen's words as nonsense.
  const visual = clipVisual(scene.visual, hasCharacter, graphic).text;
  const parts = [`${range}: Shot ${scene.number}. ${visual}`, `Camera: ${scene.camera.replace(/\s+/g, " ").trim()}.`];
  if (scene.line) {
    const who =
      scene.speaker === "on_camera"
        ? hasPresenter
          ? "The presenter (Image 1) says to camera"
          : "The presenter says to camera"
        : "The presenter's voice, off camera, says";
    parts.push(`${who}, in real time: "${scene.line}"`);
  } else {
    parts.push("No one speaks.");
  }
  if (graphic) parts.push("A graphic is added over this shot afterwards, so keep the frame calm and uncluttered here, with no text, charts or screens drawn in it.");
  if (scene.sound) parts.push(`Sound: ${scene.sound.replace(/\s+/g, " ").trim()}.`);
  return parts.join(" ");
}

export function buildClipPrompt(input: ClipPromptInput): string {
  const { script, refs, locale } = input;
  const scenes = input.sceneNumbers.map((n) => script.scenes.find((s) => s.number === n)).filter((s): s is VideoScene => Boolean(s));
  if (!scenes.length) throw new Error("A clip needs at least one scene.");
  const total = scenes.reduce((t, s) => t + s.seconds, 0);

  // Name the assets by type and order, as the model expects ("Image 1", "Video 1").
  const images: string[] = [];
  if (refs.presenter) images.push("the presenter");
  if (refs.location) images.push("the location");
  if (refs.previousFrame) images.push("the last frame of the previous shot");
  const nameOf = (label: string) => {
    const i = images.indexOf(label);
    return i >= 0 ? `Image ${i + 1}` : null;
  };
  const assetLines: string[] = [];
  if (nameOf("the presenter")) assetLines.push(`${nameOf("the presenter")} is the presenter: keep this exact person, face, hair and clothes in every shot.`);
  if (nameOf("the location")) assetLines.push(`${nameOf("the location")} is the location: keep this room and its lighting.`);
  if (nameOf("the last frame of the previous shot")) assetLines.push(`${nameOf("the last frame of the previous shot")} is where the previous shot ended: this clip opens on the same framing, the same person and the same light.`);
  if (refs.previousVideo) assetLines.push("Video 1 is the previous shot: the presenter in this clip has the same face and the same voice, pace and accent as the person in Video 1.");

  const hasPresenter = refs.presenter;
  const talks = scenes.some((s) => s.line);
  const summary = `${script.style}, realistic live-action vertical video for a Meta ad, ${total} seconds, clip ${input.clipNumber} of ${input.clipCount}.`;

  const constant = [
    script.character ? `Presenter: ${script.character}.` : "No presenter appears; keep the look of every shot consistent.",
    `Setting: ${script.setting}.`,
    talks && script.character ? `Voice: the presenter's voice is the same in every shot, natural and conversational, with ${accentFor(locale)}, speaking at an easy pace.` : null,
    `Look: ${STYLE_LOOKS[classifyStyle(script.style)]}`,
    "Hands, faces and objects are anatomically correct and undistorted.",
  ].filter((l): l is string => Boolean(l));

  let offset = 0;
  const shots = scenes.map((s) => {
    const line = shot(s, offset, input.graphicSceneNumbers.includes(s.number), hasPresenter, Boolean(script.character));
    offset += s.seconds;
    return line;
  });

  const rules = [
    "Do not draw any subtitles, captions, on-screen text, numbers, charts, logos, brand names or watermarks anywhere in the frame; they are added afterwards.",
    TEXT_FREE_RULE,
    actionRuleFor(script.style),
    "No background music; natural room sound and the speaker's voice only.",
    "Cut cleanly between shots. Keep the same person, clothes, room and colour grade throughout. Speech and mouth movement stay in sync.",
  ];

  return [
    ...assetLines,
    summary,
    ...constant,
    "Shot list:",
    ...shots,
    ...rules,
    input.clipNumber < input.clipCount ? `The clip is ${total} seconds long and ends at ${mmss(total)} mid-action, with the presenter in frame, so the next clip can follow it.` : `The clip is ${total} seconds long and ends at ${mmss(total)} on a settled final moment.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------
// The planned prompt: built from the creative plan's scene briefs instead of one global setting.
// ---------------------------------------------------------------------------------------------

export type PlannedClipPromptInput = {
  /** The scene briefs in this clip, in order. */
  scenes: SceneBrief[];
  /** For each scene, what is said (the speech text, never the display text) or null when nobody speaks. */
  spoken: Record<number, { text: string; speaker: "on_camera" | "voiceover" | "none" } | undefined>;
  characters: PlanCharacter[];
  environments: PlanEnvironment[];
  style: string;
  clipNumber: number;
  clipCount: number;
  locale: string;
  /**
   * The references this request carries, images in the order they are attached: people, then places, then the previous frame.
   * previousFrameRole: "continue" opens this clip on that frame; "look" gives it for continuity of light, grade and wardrobe only.
   * previousVideo: an earlier clip of this ad, attached as the voice reference for every clip that has speech.
   */
  refs: { characterIds: string[]; environmentIds: string[]; previousFrame: boolean; previousFrameRole?: "continue" | "look"; previousVideo: boolean };
  /** The one voice for the whole ad (from the plan), repeated word for word in every clip. */
  voice?: string;
  /** Targeted corrections from the review of the previous attempt of this clip. */
  corrections: string[];
  /** True when the clip that follows opens from where this one ends. */
  nextContinues: boolean;
  /**
   * Clean video: the footage is the finished picture. The prompt then carries nothing about graphics
   * (no "a graphic is added afterwards", no check that names an overlay, no style clause about a
   * composited asset), because the video model draws whatever its prompt mentions.
   */
  clean?: boolean;
};

/** A footage field as it may be sent in a clean prompt: a sentence that mentions a graphic is dropped rather than sent. */
function filmed(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!graphicReference(flat)) return flat;
  return flat
    .split(/(?<=[.;!?])\s+|\s+[\u2014\u2013-]\s+/)
    .filter((part) => part.trim() && !graphicReference(part))
    .join(" ")
    .trim();
}

/** Mentions in the prompt of the same person across clips ("Video 1") only make sense when that person also speaks here. */
export function buildPlannedClipPrompt(input: PlannedClipPromptInput): string {
  const { scenes, refs } = input;
  if (!scenes.length) throw new Error("A clip needs at least one scene.");
  const total = scenes.reduce((t, s) => t + s.seconds, 0);
  const isClean = Boolean(input.clean);
  // In a clean video every footage field is passed through `filmed`, so a stray mention of a graphic never reaches the video model.
  const clean = (t: string) => (isClean ? filmed(t) : t.replace(/\s+/g, " ").trim());
  const style = isClean ? stripGraphicPhrases(input.style) || "Live action" : clean(input.style);
  const isLastClip = input.clipNumber >= input.clipCount;

  // Assets are named by type and attach order: "Image 1", "Image 2", "Video 1".
  const imageLabels: Array<{ label: string; text: string }> = [];
  for (const id of refs.characterIds) {
    const c = input.characters.find((x) => x.id === id);
    if (c) imageLabels.push({ label: `person:${id}`, text: `is ${clean(c.role || "the person")}: keep this exact person, face, hair and clothes wherever they appear. Use it for who they are only; ignore its plain backdrop and light, and place them in each shot's own setting.` });
  }
  for (const id of refs.environmentIds) {
    const e = input.environments.find((x) => x.id === id);
    if (e) imageLabels.push({ label: `place:${id}`, text: `is the place "${clean(e.description).slice(0, 120)}": keep this place and its light for the shots set there.` });
  }
  if (refs.previousFrame) {
    imageLabels.push(
      refs.previousFrameRole === "look"
        ? { label: "previous", text: "is the last frame of the previous clip of this same ad, given for continuity only: match its colour grade, light quality, film look, and any shared person's face, hair and clothes. This clip starts on its own new shot, not on that framing." }
        : { label: "previous", text: "is where the previous shot ended: this clip opens on the same framing, the same person and the same light." },
    );
  }
  const assetLines = imageLabels.map((l, i) => `Image ${i + 1} ${l.text}`);
  if (refs.previousVideo) {
    assetLines.push(
      "Video 1 is an earlier clip of this same ad and is the VOICE REFERENCE: every word spoken in this clip, on camera or off, is in exactly the voice heard in Video 1, with the same timbre, pitch, accent, pace, loudness and microphone sound, as if recorded in the same session. Where the same person appears, they also keep the face from Video 1. Do not copy Video 1's shots, framing or action.",
    );
  }

  const used = new Set(scenes.map((s) => s.characterId).filter((id): id is string => Boolean(id)));
  const people = input.characters.filter((c) => used.has(c.id));
  // Any speech, on camera or off, gets the same fixed voice description: the voice is what the viewer notices changing first.
  const talks = scenes.some((s) => input.spoken[s.number]?.text.trim());
  const voice = input.voice?.trim() || `a natural, conversational adult voice with ${accentFor(input.locale)}, mid pitch, an easy steady pace`;
  const constant = [
    ...people.map((c) => `Person (${c.id}): ${clean(c.description)}.`),
    !people.length ? "No person appears on camera in this clip; keep the look of every shot consistent." : null,
    talks ? `Voice (identical in every clip of this ad): ${voice.replace(/[.\s]+$/, "")}. The same single voice speaks every line, saying every word clearly and completely, with the same close, clean microphone sound and no change in tone, pitch or accent between shots.` : null,
    `Look: ${style}. ${wantsRealism(input.style) ? REALISM_RULE : "Real skin texture, natural light, believable materials."}`,
    "Hands, faces and objects are anatomically correct and undistorted; faces stay stable with no morphing, glowing marks or flicker.",
  ].filter((l): l is string => Boolean(l));

  let offset = 0;
  const shots = scenes.map((s) => {
    const range = `${offset}s-${offset + s.seconds}s`;
    offset += s.seconds;
    // A field that had to be dropped from a clean prompt (it described a graphic) is replaced by a plain description, never left as a gap.
    const or = (text: string, fallback: string) => clean(text).replace(/[.\s]+$/, "") || fallback;
    const parts = [
      `${range}: Shot ${s.number}. ${or(s.framing, "Medium shot")} of ${or(s.subject, s.characterId ? "the person" : "the scene")} in ${or(s.setting, "the same place")}. Action: ${or(s.action, s.characterId ? "the person holds a natural, relaxed posture" : "the scene plays out naturally")}.`,
      `Camera: ${or(s.camera, "steady, eye level")}. Light: ${or(s.lighting, "the natural light of this place and time of day")}.`,
    ];
    const say = input.spoken[s.number];
    if (say && say.text.trim()) {
      const who = say.speaker === "on_camera" ? "The person on camera says, in real time" : "A voice off camera says";
      // The spoken words are passed on exactly: they are speech, and are never filtered as if they described the picture.
      parts.push(`${who}: "${say.text.split(/\s+/).join(" ").trim()}"`);
      if (say.speaker !== "on_camera" && s.characterId) parts.push("The person's mouth stays closed and still while the voice speaks.");
    } else {
      parts.push("No one speaks." + (s.characterId ? " The person's mouth stays closed and relaxed." : ""));
    }
    if (!isClean && (s.screenTreatment !== "none" || s.overlays.some((o) => o.kind === "stat" || o.kind === "image"))) {
      parts.push("A graphic is added over this shot afterwards: keep that part of the frame calm and uncluttered, with no readable screens, charts or text drawn anywhere.");
    }
    // Only checks about the filmed footage are shown to the video model: one that names an overlay would be drawn into the picture.
    const musts = (isClean ? footageOnly(s.acceptance) : s.acceptance).slice(0, 3).map(clean).filter(Boolean);
    if (musts.length) parts.push(`This shot must show: ${musts.join("; ")}.`);
    return parts.join(" ");
  });

  const rules = [
    isClean ? CLEAN_FOOTAGE_RULE : "Do not draw any subtitles, captions, on-screen text, numbers, charts, logos, brand names, buttons or watermarks anywhere in the frame; the real ones are added afterwards.",
    TEXT_FREE_RULE,
    actionRuleFor(input.style),
    "No background music; natural room sound and the speaker's voice only.",
    "Cut cleanly between shots. Keep the same person, clothes and colour grade for the shots they share; a new place may have its own light.",
    ...(isClean && isLastClip ? [CLEAN_ENDING_RULE] : []),
  ];
  const fixes = input.corrections.length ? ["Fix these problems from the previous attempt:", ...input.corrections.map((c) => `- ${c.split(/\s+/).join(" ").trim()}`)] : [];

  return [
    ...assetLines,
    `${style}, realistic live-action vertical video${isClean ? "" : " for a Meta ad"}, ${total} seconds, clip ${input.clipNumber} of ${input.clipCount}.`,
    ...constant,
    "Shot list:",
    ...shots,
    ...rules,
    ...fixes,
    input.nextContinues ? `The clip is ${total} seconds long and ends at ${mmss(total)} mid-action so the next clip can follow it.` : `The clip is ${total} seconds long and ends at ${mmss(total)} on a settled moment.`,
  ].join("\n");
}
