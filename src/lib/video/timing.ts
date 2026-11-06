/**
 * How long a scene runs, decided by what is said in it.
 *
 * A scene is as long as its line takes to say at a natural pace, plus a beat to land it. Scenes with
 * no speech get a short visual beat. Nothing is padded or squeezed to hit a total: the video is as
 * long as the script needs. Pure, so the editor, the server and the tests agree.
 */

/** About what a relaxed, conversational speaker manages in English. */
export const WORDS_PER_SECOND = 2.7;
/** A breath after the line, so it lands before the cut. */
export const LANDING_PAUSE = 0.3;
export const MIN_SCENE_SECONDS = 2;
/** A stat or an uploaded image needs time to be read. */
export const MIN_SECONDS_WITH_GRAPHIC = 3;
export const SILENT_BEAT = { min: 2, max: 6, fallback: 3 } as const;

export function wordsIn(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export type TimedScene = {
  line: string;
  speaker: "on_camera" | "voiceover" | "none";
  stat: string | null;
  assetId: string | null;
  /** For a scene with no speech: how long the visual should hold. */
  seconds?: number;
};

/** Whole seconds, because a clip is generated in whole seconds. */
export function sceneSeconds(scene: TimedScene): number {
  const words = wordsIn(scene.line);
  const graphic = scene.stat || scene.assetId ? MIN_SECONDS_WITH_GRAPHIC : MIN_SCENE_SECONDS;
  if (scene.speaker === "none" || words === 0) {
    const beat = Number(scene.seconds) || SILENT_BEAT.fallback;
    return Math.max(graphic, Math.min(Math.max(Math.round(beat), SILENT_BEAT.min), SILENT_BEAT.max));
  }
  return Math.max(graphic, Math.ceil(words / WORDS_PER_SECOND + LANDING_PAUSE));
}

/** Give every scene the length its text needs, and lay them end to end. */
export function retime<T extends TimedScene>(scenes: T[]): Array<T & { seconds: number; start: number; end: number }> {
  let cursor = 0;
  return scenes.map((s) => {
    const seconds = sceneSeconds(s);
    const out = { ...s, seconds, start: cursor, end: cursor + seconds };
    cursor += seconds;
    return out;
  });
}

/** The most words a scene of this length can carry at a natural pace. */
export function wordsFor(seconds: number): number {
  return Math.floor((seconds - LANDING_PAUSE) * WORDS_PER_SECOND);
}
