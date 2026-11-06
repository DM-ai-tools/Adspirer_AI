import { mmss } from "@/lib/video/overlays";
import type { VideoScene, VideoScript } from "@/lib/video/script";

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

function shot(scene: VideoScene, offset: number, graphic: boolean, hasPresenter: boolean): string {
  const start = offset;
  const end = offset + scene.seconds;
  const range = `${start}s-${end}s`;
  const parts = [`${range}: Shot ${scene.number}. ${scene.visual.replace(/\s+/g, " ").trim()}`, `Camera: ${scene.camera.replace(/\s+/g, " ").trim()}.`];
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
    "Look: natural, believable lighting, real skin and fabric, sharp focus on the subject. Hands, faces and objects are anatomically correct and undistorted.",
  ].filter((l): l is string => Boolean(l));

  let offset = 0;
  const shots = scenes.map((s) => {
    const line = shot(s, offset, input.graphicSceneNumbers.includes(s.number), hasPresenter);
    offset += s.seconds;
    return line;
  });

  const rules = [
    "Do not draw any subtitles, captions, on-screen text, numbers, charts, logos, brand names or watermarks anywhere in the frame; they are added afterwards.",
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
