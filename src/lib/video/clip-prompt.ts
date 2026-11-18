import { mmss } from "@/lib/video/overlays";
import { actionRuleFor, classifyStyle, clipVisual, isStillAction, liveCamera, MOTION_RULE, movementLine, REALISM_RULE, STYLE_LOOKS, TEXT_FREE_RULE, wantsRealism } from "@/lib/video/visual-rules";
import { CLEAN_ENDING_RULE, CLEAN_ENDING_RULE_NO_PERSON, CLEAN_FOOTAGE_RULE, footageOnly, graphicReference, stripGraphicPhrases } from "@/lib/video/clean-mode";
import type { VideoScene, VideoScript } from "@/lib/video/script";
import type { PlanCharacter, PlanEnvironment, SceneBrief } from "@/lib/video/pipeline-types";
import { accentFor, characterOfVoice, dropAimlessPointer, languageReminder, languageRule, liveAction, liveFraming, onlyInShotLine, PLAIN_SURFACES_RULE, pointingLine, presentFromFirstFrame, reconcileVoicesWithCast, SAY_ONCE_RULE, sceneCharacterIds, showPointedAt } from "@/lib/video/prompt-guards";

export { accentFor };

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

function shot(scene: VideoScene, offset: number, graphic: boolean, hasPresenter: boolean, hasCharacter: boolean): string {
  const start = offset;
  const end = offset + scene.seconds;
  const range = `${start}s-${end}s`;
  // A shot that is mainly a screen is filmed as the person's reaction: the model would draw the screen's words as nonsense.
  const visual = clipVisual(scene.visual, hasCharacter, graphic).text;
  const parts = [`${range}: Shot ${scene.number}. ${visual}`, `Camera: ${liveCamera(scene.camera)}.`, movementLine(hasCharacter || hasPresenter, isStillAction(visual))];
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
  const summary = `${script.style}, production-quality live-action vertical video for a Meta ad, shot by a film crew with a moving camera, ${total} seconds, clip ${input.clipNumber} of ${input.clipCount}.`;

  const constant = [
    script.character ? `Presenter: ${script.character}.` : "No presenter appears; keep the look of every shot consistent.",
    `Setting: ${script.setting}.`,
    talks ? languageRule(locale) : null,
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
    MOTION_RULE,
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
    input.clipNumber < input.clipCount ? `The clip is ${total} seconds long and ends at ${mmss(total)} mid-action, with the presenter in frame, so the next clip can follow it.` : `The clip is ${total} seconds long and ends at ${mmss(total)} on a calm moment that is still alive: people breathing and moving a little, the light and the camera still drifting, never a held pose or a frozen frame.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------
// The planned prompt: built from the creative plan's scene briefs instead of one global setting.
// ---------------------------------------------------------------------------------------------

/** A speaking voice in a clip with several voices; videoRef is its reference video's number, or null when it has none yet. */
export type PlannedVoice = { id: string; who: string; description: string; videoRef: number | null };

/** One spoken part of a scene when the script has several voices. */
export type SpokenPart = { voiceId: string; who: string; text: string; onCamera: boolean };

export type PlannedClipPromptInput = {
  /** The scene briefs in this clip, in order. */
  scenes: SceneBrief[];
  /** For each scene, what is said (the speech text, never the display text) or null when nobody speaks. */
  spoken: Record<number, { text: string; speaker: "on_camera" | "voiceover" | "none"; parts?: SpokenPart[] } | undefined>;
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
  /** Several speaking voices: each with its own fixed description and, when it has one, its own reference video. Replaces `voice`. */
  voices?: PlannedVoice[];
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

/** "marcus" is Marcus, "business_owner" is Business Owner. */
const titleOf = (c: PlanCharacter) => c.id.replace(/[_-]+/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
const flatName = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Mentions in the prompt of the same person across clips ("Video 1") only make sense when that person also speaks here. */
export function buildPlannedClipPrompt(input: PlannedClipPromptInput): string {
  const { scenes, refs } = input;
  // A voice described as one gender for a person shown as the other is made to match the person on screen.
  const castVoices = input.voices?.length ? reconcileVoicesWithCast(input.voices, input.characters) : input.voices;
  if (!scenes.length) throw new Error("A clip needs at least one scene.");
  const total = scenes.reduce((t, s) => t + s.seconds, 0);
  const isClean = Boolean(input.clean);
  // In a clean video every footage field is passed through `filmed`, so a stray mention of a graphic never reaches the video model.
  const clean = (t: string) => (isClean ? filmed(t) : t.replace(/\s+/g, " ").trim());
  const style = isClean ? stripGraphicPhrases(input.style) || "Live action" : clean(input.style);
  const isLastClip = input.clipNumber >= input.clipCount;

  // Assets are named by type and attach order: "Image 1", "Image 2", "Video 1".
  const imageLabels: Array<{ label: string; text: string; defines?: string }> = [];
  for (const id of refs.characterIds) {
    const c = input.characters.find((x) => x.id === id);
    // Two people can share a role ("Presenter"): the picture is named by who they are, so the voices and shots point at the right one.
    // The subject is defined the way the Seedance guide asks ("Define the person in Image 1 as ..."), by one label used every time.
    if (c) imageLabels.push({ label: `person:${id}`, defines: input.characters.some((o) => o.id !== c.id && flatName(o.role ?? "") === flatName(c.role ?? "")) ? `${titleOf(c)} (${clean(c.role || "the person")})` : clean(c.role || "the person"), text: "keep this exact person, face, hair and clothes wherever they appear. Use it for who they are only; ignore its plain backdrop and light, and place them in each shot's own setting." });
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
  const assetLines = imageLabels.map((l, i) => (l.defines ? `Define the person in Image ${i + 1} as ${l.defines}: ${l.text}` : `Image ${i + 1} ${l.text}`));
  if (refs.previousVideo) {
    assetLines.push(
      "Video 1 is an earlier clip of this same ad and is the VOICE REFERENCE: every word spoken in this clip, on camera or off, is in exactly the voice heard in Video 1, with the same timbre, pitch, accent, pace, loudness and microphone sound, as if recorded in the same session. Where the same person appears, they also keep the face from Video 1. Do not copy Video 1's shots, framing or action.",
    );
  }

  const several = Boolean(castVoices?.length);
  for (const v of castVoices ?? []) {
    if (v.videoRef === null) continue;
    assetLines.push(
      `Video ${v.videoRef} is the VOICE REFERENCE for ${v.who}: every line ${v.who} says in this clip is in exactly the voice heard in Video ${v.videoRef}, with the same timbre, pitch, accent, pace and microphone sound. Use it only for the voice: do not copy its shots, framing or action.`,
    );
  }

  // Everyone whose picture is attached is described too: a person who appears in a shot is never left to the model's imagination.
  const used = new Set([...scenes.map((s) => s.characterId).filter((id): id is string => Boolean(id)), ...refs.characterIds]);
  const people = input.characters.filter((c) => used.has(c.id));
  // Any speech, on camera or off, gets the same fixed voice description: the voice is what the viewer notices changing first.
  const talks = scenes.some((s) => input.spoken[s.number]?.text.trim());
  const voice = input.voice?.trim() || `a natural, conversational adult voice with ${accentFor(input.locale)}, mid pitch, an easy steady pace`;
  // A voice that belongs to a person on screen says so, so the model gives that voice to that face and not to another.
  const voiceOwner = (who: string) => {
    const owner = characterOfVoice(input.characters, who);
    const at = owner ? imageLabels.findIndex((l) => l.label === `person:${owner.id}`) : -1;
    return at >= 0 ? ` (the voice of the person in Image ${at + 1})` : "";
  };
  const constant = [
    ...people.map((c) => `Person (${c.id}): ${clean(c.description).replace(/[.\s]+$/, "")}.`),
    !people.length ? "No person appears on camera in this clip; keep the look of every shot consistent." : null,
    talks ? languageRule(input.locale) : null,
    talks && several
      ? `Voices (each one identical in every clip of this ad, and never swapped between speakers): ${castVoices!.map((v) => `${v.who}: ${v.description.replace(/[.\s]+$/, "") || `a natural adult voice with ${accentFor(input.locale)}`}${voiceOwner(v.who)}`).join("; ")}. Every word is said clearly and completely, by the speaker named for it.`
      : null,
    talks && !several ? `Voice (identical in every clip of this ad): ${voice.replace(/[.\s]+$/, "")}. The same single voice speaks every line, saying every word clearly and completely, with the same close, clean microphone sound and no change in tone, pitch or accent between shots.` : null,
    `Look: ${style}. ${wantsRealism(input.style) ? REALISM_RULE : "Real skin texture, natural light, believable materials."}`,
    "Hands, faces and objects are anatomically correct and undistorted; faces stay stable with no morphing, glowing marks or flicker.",
  ].filter((l): l is string => Boolean(l));

  // A person is named the same way every time, with the picture that shows them ("Founder (Image 1)"), as the Seedance guide asks.
  const tagged = (who: string, owner: PlanCharacter | undefined) => {
    const at = owner ? imageLabels.findIndex((l) => l.label === `person:${owner.id}`) : -1;
    return at >= 0 ? `${who} (Image ${at + 1})` : who;
  };
  // Words to be said go in braces, the form the guide uses for dialogue; a brace inside the words themselves is dropped.
  const braced = (t: string) => `{${t.split(/\s+/).join(" ").replace(/[{}]/g, "").trim()}}`;
  const shots = scenes.map((s) => {
    // The length is a pace, not a hard cut: the guide warns that forced time ranges give unstable results.
    const range = `Shot ${s.number} (about ${s.seconds} seconds)`;
    // A field that had to be dropped from a clean prompt (it described a graphic) is replaced by a plain description, never left as a gap.
    const or = (text: string, fallback: string) => clean(text).replace(/[.\s]+$/, "") || fallback;
    const say = input.spoken[s.number];
    const onCameraWho = say?.parts?.length ? [...new Set(say.parts.filter((p) => p.onCamera).map((p) => p.who))] : [];
    const speaksOnCamera = Boolean(say?.text.trim()) && (say?.speaker === "on_camera" || onCameraWho.length > 0);
    // Someone who speaks from the shot's first second is already in it: an entrance would leave a voice over an empty set.
    const settle = (t: string) => (speaksOnCamera ? presentFromFirstFrame(t) : t);
    const action = liveAction(settle(or(s.action, s.characterId ? "the person moves naturally, shifting their weight and glancing around" : "the scene plays out with natural movement")));
    // What is pointed at has to be in the picture: a close-up is widened to show it, and a pointer with no target is put down.
    const framing = showPointedAt(liveFraming(or(s.framing, "Medium shot")), action);
    const inShot = input.characters.filter((c) => sceneCharacterIds(input.characters, s, onCameraWho).includes(c.id));
    // In the order the guide gives: the camera, then who is where and what they do, then the light; sound and speech follow.
    const parts = [
      // A camera written as static is made to move here: a locked-off frame is what makes a clip read as a slide.
      `${range}. Camera: ${framing}, ${dropAimlessPointer(liveCamera(settle(clean(s.camera))))}.`,
      `Subject and place: ${or(s.subject, s.characterId ? "the person" : "the scene")} in ${or(s.setting, "the same place")}. Action: ${action}. Light: ${or(s.lighting, "the natural light of this place and time of day")}.`,
      movementLine(Boolean(s.characterId), isStillAction(s.action ?? "")),
      onlyInShotLine(inShot, people),
      pointingLine(action),
    ].filter((l): l is string => Boolean(l));
    if (speaksOnCamera) {
      const names = onCameraWho.length ? onCameraWho : inShot.map(titleOf);
      const who = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)} are` : names.length === 1 ? `${names[0]} is` : "The speaker is";
      parts.push(`${who} in frame, facing the camera with a clearly visible mouth, from the very first frame of this shot until the line ends; a voice is never heard over an empty frame.`);
    }
    if (say?.parts?.length) {
      // Several voices: who says each line, in order, and only the person speaking on camera moves their lips.
      for (const part of say.parts) parts.push(`${tagged(part.who, characterOfVoice(input.characters, part.who) ?? undefined)}, ${part.onCamera ? "on camera" : "off camera"}, says ${braced(part.text)}`);
      if (s.characterId) parts.push(say.parts.some((p) => p.onCamera) ? "Only the person speaking on camera moves their lips, and only while they speak." : "The person's mouth stays closed and relaxed while the voices speak, with natural breathing and small head movements.");
    } else if (say && say.text.trim()) {
      // One person in frame who speaks is named and tied to their picture; otherwise it is the person on camera or a voice off camera.
      const solo = say.speaker === "on_camera" && inShot.length === 1 ? inShot[0] : undefined;
      const who = say.speaker === "on_camera" ? (solo ? `${tagged(titleOf(solo), solo)}, on camera, says in real time` : "The person on camera says, in real time") : "A voice off camera says";
      // The spoken words are passed on exactly: they are speech, and are never filtered as if they described the picture.
      parts.push(`${who} ${braced(say.text)}`);
      if (say.speaker !== "on_camera" && s.characterId) parts.push("The person's mouth stays closed and relaxed while the voice speaks, with natural breathing and small head movements.");
    } else {
      parts.push("No one speaks." + (s.characterId ? " The person's mouth stays closed and relaxed." : ""));
    }
    if (!isClean && (s.screenTreatment !== "none" || s.overlays.some((o) => o.kind === "stat" || o.kind === "image"))) {
      parts.push("A graphic is added over this shot afterwards: keep that part of the frame calm and uncluttered, with no readable screens, charts or text drawn anywhere.");
    }
    // Only checks about the filmed footage are shown to the video model: one that names an overlay would be drawn into the picture.
    // The plan's acceptance checks are written for a reviewer ("Check that...", "Ensure..."): to the video model they are stated as what the shot shows, and a check that only repeats the constraints is left out.
    const musts = (isClean ? footageOnly(s.acceptance) : s.acceptance)
      .map((m) => clean(m).replace(/^(?:check|ensure|verify|confirm|make sure)\s+(?:that\s+)?/i, "").replace(/[.\s]+$/, ""))
      .filter((m) => m && !/^no (?:readable )?text, numbers, logos/i.test(m))
      .slice(0, 3);
    if (musts.length) parts.push(`This shot must show: ${musts.join("; ")}.`);
    return parts.join(" ");
  });

  const rules = [
    isClean ? CLEAN_FOOTAGE_RULE : "Do not draw any subtitles, captions, on-screen text, numbers, charts, logos, brand names, buttons or watermarks anywhere in the frame; the real ones are added afterwards.",
    TEXT_FREE_RULE,
    PLAIN_SURFACES_RULE,
    actionRuleFor(input.style),
    MOTION_RULE,
    ...(talks ? [SAY_ONCE_RULE] : []),
    "Audio: (no background music); natural room sound and the speakers' voices only.",
    // The guide's own fix for duplicated people: each one appears once, as in their picture.
    ...(people.length ? ["Each person appears exactly once in the frame and looks exactly like their reference picture. No duplicate avatars, no twin or repeated copies of anyone, and nobody who is not described."] : []),
    "Cut cleanly between shots. Keep the same person, clothes and colour grade for the shots they share; a new place may have its own light.",
    // The last shot decides who is looked at: an empty room is not asked to look at the camera.
    ...(isClean && isLastClip ? [scenes[scenes.length - 1].characterId ? CLEAN_ENDING_RULE : CLEAN_ENDING_RULE_NO_PERSON] : []),
  ];
  const fixes = input.corrections.length ? ["Fix these problems from the previous attempt:", ...input.corrections.map((c) => `- ${c.split(/\s+/).join(" ").trim()}`)] : [];

  return [
    ...assetLines,
    `${style}, production-quality live-action vertical video${isClean ? "" : " for a Meta ad"}, shot by a film crew with a moving camera, ${total} seconds, clip ${input.clipNumber} of ${input.clipCount}.`,
    ...constant,
    "Storyboard (shots in the order they happen, each one continuous):",
    ...shots,
    "Constraints:",
    ...rules,
    ...fixes,
    ...(talks ? [languageReminder(input.locale)] : []),
    input.nextContinues ? `The clip is ${total} seconds long and ends at ${mmss(total)} mid-action so the next clip can follow it.` : `The clip is ${total} seconds long and ends at ${mmss(total)} on a calm moment that is still alive: people breathing and moving a little, the light and the camera still drifting, never a held pose or a frozen frame.`,
  ].join("\n");
}
