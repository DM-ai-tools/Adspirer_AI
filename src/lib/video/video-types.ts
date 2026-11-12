/**
 * The kinds of video ad the operator can ask for before a script is read or written. Each carries
 * the look (fed to the script's style, which decides the footage look and the camera rules) and a
 * creative direction (fed to the script reader or writer and to the creative planner).
 *
 * Chosen from the formats that perform on Meta Reels/Stories and TikTok: creator-style talking
 * heads and testimonials, a presenter in a produced set, a cinematic brand film with voiceover, a
 * high-energy trailer cut, a short story with a turn, a documentary customer story, a product hero
 * film, before and after, POV / day in the life, and stylised 3D animation.
 */

export type VideoTypeId =
  | "auto"
  | "ugc_creator"
  | "avatar_cinematic"
  | "cinematic_film"
  | "action_trailer"
  | "storytelling"
  | "documentary_story"
  | "product_hero"
  | "before_after"
  | "pov_lifestyle"
  | "animation_3d";

export type VideoType = {
  id: VideoTypeId;
  label: string;
  /** One line for the picker. */
  blurb: string;
  /** The script style: it decides the footage look and the camera rules downstream. Empty for auto. */
  style: string;
  /** Who is seen and heard. */
  speaker: "on_camera" | "voiceover" | "either";
  /** What the reader, writer and planner are told to build. */
  direction: string;
};

export const VIDEO_TYPES: VideoType[] = [
  // Each type fixes the FORMAT only: who is on screen, how it is shot and cut, its pacing and look.
  // No type names a place, a background, a prop or a light source: those come from the script, every time.
  {
    id: "auto",
    label: "Let the AI choose",
    blurb: "An expert creative director picks the format and designs every scene from your script.",
    style: "",
    speaker: "either",
    direction: "",
  },
  {
    id: "ugc_creator",
    label: "UGC creator",
    blurb: "A real-looking person talks to their phone camera: honest, native to the feed.",
    style: "UGC creator talking to camera, phone-shot",
    speaker: "on_camera",
    direction:
      "Format: a UGC creator ad. One relatable person, filmed as if on their own phone held at arm's length, talking straight to the viewer. Casual, unscripted-feeling delivery with natural pauses and small reactions; jump cuts between beats; cut-aways to what they are talking about. No studio polish.",
  },
  {
    id: "avatar_cinematic",
    label: "Cinematic with presenter",
    blurb: "A presenter speaks to camera, filmed like a premium commercial.",
    style: "Cinematic presenter to camera",
    speaker: "on_camera",
    direction:
      "Format: a cinematic presenter ad. One confident, warm presenter speaks to camera, filmed like a premium commercial (35mm look, shallow depth of field, motivated light). The presenter moves through the places the story needs, with cut-aways that show what they describe. The presenter stays the same person in the same clothes throughout.",
  },
  {
    id: "cinematic_film",
    label: "Cinematic brand film",
    blurb: "No presenter: voiceover over striking, film-quality shots.",
    style: "Cinematic brand film with voiceover",
    speaker: "voiceover",
    direction:
      "Format: a cinematic brand film. No one speaks to camera; a single voiceover carries every line over a sequence of film-quality shots with strong compositions, motivated light and considered camera moves, an emotional build and a resolved final image.",
  },
  {
    id: "action_trailer",
    label: "Action / trailer sequence",
    blurb: "High-energy, movie-trailer pacing with dynamic camera and impact moments.",
    style: "Action trailer sequence, high energy",
    speaker: "voiceover",
    direction:
      "Format: an action-movie trailer. High energy and momentum: short, punchy shots, dynamic but readable camera, dramatic contrast, real physical motion, a build to one big impact moment, then a calm final shot. A deep, confident trailer-style voiceover carries the lines. Every action stays physically plausible and simple within its shot.",
  },
  {
    id: "storytelling",
    label: "Story with a twist",
    blurb: "A mini short film: a character, a problem, a turning point, a payoff.",
    style: "Narrative short film",
    speaker: "either",
    direction:
      "Format: a mini short film. A character the audience recognises meets a specific problem, reaches a turning point where the product or service changes things, and ends on a satisfying payoff. Scenes, not montage; the same character throughout; every scene moves the story forward. Lines can be the character speaking in the scene or a narrator.",
  },
  {
    id: "documentary_story",
    label: "Customer story / documentary",
    blurb: "Observational, interview-style footage of a real-feeling customer or owner.",
    style: "Documentary interview and observational footage",
    speaker: "either",
    direction:
      "Format: a documentary customer story. A believable customer or owner is interviewed looking just off camera, intercut with observational footage of their day and of the difference the service made. Handheld, available light, honest moments.",
  },
  {
    id: "product_hero",
    label: "Product hero film",
    blurb: "Premium close-ups of the product or service in use, with a voiceover.",
    style: "Product hero film, commercial close-ups",
    speaker: "voiceover",
    direction:
      "Format: a product hero film. Premium commercial close-ups of the product or the service in action: real hands using it, textures and details, controlled light, ending on the product at its best. A voiceover carries the lines.",
  },
  {
    id: "before_after",
    label: "Before and after",
    blurb: "The frustrating 'before', then the transformed 'after'.",
    style: "Before and after transformation, live action",
    speaker: "either",
    direction:
      "Format: before and after. The first half shows the frustrating 'before', the second half the same person or place 'after', with a clear turning moment between. Matching framings in the before and after shots so the change reads instantly; the grade and light shift with the mood.",
  },
  {
    id: "pov_lifestyle",
    label: "POV / day in the life",
    blurb: "First-person or follow-cam moments from the customer's real day.",
    style: "POV lifestyle, day in the life",
    speaker: "voiceover",
    direction:
      "Format: POV / day in the life. We see the customer's day through their eyes or from just behind their shoulder: real moments, the problem showing up naturally and the product or service fitting into the day. A follow camera and a voiceover in the customer's own voice.",
  },
  {
    id: "animation_3d",
    label: "3D animation",
    blurb: "Stylised, friendly 3D animated characters and worlds.",
    style: "3D animated, stylised",
    speaker: "voiceover",
    direction:
      "Format: stylised 3D animation. Appealing characters with simple shapes, smooth expressive motion, and clear visual metaphors for the problem and the solution, in a world designed for this story. A voiceover carries the lines. No readable text or numbers drawn anywhere.",
  },
];

/**
 * "Let the AI choose": a full creative brief, not an absence of one. The planner picks the format
 * that will perform best for THIS script and designs every scene like a top creative director.
 */
export const AUTO_DIRECTION = [
  "Video type: let the AI choose. You are the creative director: pick the format that will stop the scroll and sell THIS message best, and say which in narrative.approach.",
  `Formats to choose from (or combine): ${VIDEO_TYPES.filter((t) => t.id !== "auto").map((t) => `${t.label} (${t.blurb.replace(/[.:].*$/, "").toLowerCase()})`).join("; ")}.`,
  "Then design it like an award-winning ad: one bold central idea drawn from the script's own world; an opening shot in the first second that a viewer has not seen before; every scene a specific, concrete moment (who, where, what happens, what the light is) that only this ad could have; places, people, props, light and time of day taken from what each line is about, never from a stock look; shot sizes and angles that change with the story; cuts and transitions that carry momentum; and a final image that lands the message.",
].join("\n");

export const VIDEO_TYPE_IDS = VIDEO_TYPES.map((t) => t.id) as [VideoTypeId, ...VideoTypeId[]];

export function videoTypeOf(id: string | null | undefined): VideoType {
  return VIDEO_TYPES.find((t) => t.id === id) ?? VIDEO_TYPES[0]!;
}

/**
 * The creative direction for a video, from the chosen type and the operator's own idea, as one block
 * of text for the reader, writer and planner. Null when nothing was chosen or written.
 */
export function videoDirection(inputs: { videoType?: string | null; videoIdea?: string | null; instructions?: string | null }): string | null {
  const type = videoTypeOf(inputs.videoType);
  const idea = inputs.videoIdea?.replace(/\s+/g, " ").trim();
  const instructions = inputs.instructions?.replace(/\s+/g, " ").trim();
  const parts: string[] = [];
  if (type.id === "auto") parts.push(AUTO_DIRECTION);
  else {
    parts.push(`Video type chosen by the operator: ${type.label}. ${type.direction} Everything else (the places, people, props, light, time of day, shots and transitions) is designed from the script, scene by scene.`);
    if (type.speaker === "on_camera") parts.push("Who speaks: a person on camera, to the lens.");
    if (type.speaker === "voiceover") parts.push("Who speaks: an unseen voiceover; nobody talks to camera.");
  }
  // The operator's own words outrank every default here: they are followed wherever they are filmable and fit the brand.
  if (idea) parts.push(`The operator's own idea for the video (follow it closely; it outranks the format's defaults): ${idea}`);
  if (instructions) parts.push(`The operator's instructions (follow them where they concern the video): ${instructions}`);
  return parts.join("\n");
}

/** The style a chosen type sets, or null to keep whatever the script or the writer chose. */
export function styleForType(id: string | null | undefined): string | null {
  return videoTypeOf(id).style || null;
}
