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
  {
    id: "auto",
    label: "Let the AI choose",
    blurb: "Picks the format that suits the script and the offer.",
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
      "A UGC creator ad: one relatable person, filmed as if on their own phone held at arm's length, talking straight to the viewer in their real home, car or workplace. Casual, unscripted-feeling delivery, natural pauses and small reactions, jump cuts between beats, a cut-away now and then to them using or showing the thing they talk about. No studio polish.",
  },
  {
    id: "avatar_cinematic",
    label: "Cinematic with presenter",
    blurb: "A presenter speaks to camera in beautifully lit, changing real locations.",
    style: "Cinematic presenter to camera",
    speaker: "on_camera",
    direction:
      "A cinematic presenter ad: one confident, warm presenter speaks to camera, filmed like a premium commercial (35mm look, shallow depth of field, motivated light). The presenter moves through two or three real, characterful locations that fit the story, with cut-aways that show what they describe. The presenter stays the same person in the same clothes throughout.",
  },
  {
    id: "cinematic_film",
    label: "Cinematic brand film",
    blurb: "No presenter: voiceover over striking, film-quality shots.",
    style: "Cinematic brand film with voiceover",
    speaker: "voiceover",
    direction:
      "A cinematic brand film: no one speaks to camera. A single voiceover carries the words over a sequence of film-quality shots: real people and places from the customer's world, strong compositions, motivated light, considered camera moves, an emotional build and a resolved final image. Every line is voiceover.",
  },
  {
    id: "action_trailer",
    label: "Action / trailer sequence",
    blurb: "High-energy, movie-trailer pacing with dynamic camera and impact moments.",
    style: "Action trailer sequence, high energy",
    speaker: "voiceover",
    direction:
      "An action-movie trailer ad: high energy and momentum. Short, punchy shots with dynamic but controlled camera (tracking shots, low angles, push-ins, a fast whip only at a cut), dramatic light and contrast, real motion (running, a door swinging open, a car pulling away, sparks of activity), a build to one big impact moment, then a calm final shot. A deep, confident trailer-style voiceover carries the lines. Action stays physically plausible and simple for each shot.",
  },
  {
    id: "storytelling",
    label: "Story with a twist",
    blurb: "A mini short film: a character, a problem, a turning point, a payoff.",
    style: "Narrative short film",
    speaker: "either",
    direction:
      "A mini short film: a character the audience recognises meets a specific, relatable problem, reaches a turning point where the product or service changes things, and ends on a satisfying payoff. Shot like a short film: scenes, not montage; the same character throughout; each scene moves the story forward. Lines can be the character speaking in the scene or a narrator.",
  },
  {
    id: "documentary_story",
    label: "Customer story / documentary",
    blurb: "Observational, interview-style footage of a real-feeling customer or owner.",
    style: "Documentary interview and observational footage",
    speaker: "either",
    direction:
      "A documentary customer story: a believable customer or business owner is interviewed in their own place, looking just off camera, intercut with observational footage of their day and the result the service made. Handheld, available light, honest moments.",
  },
  {
    id: "product_hero",
    label: "Product hero film",
    blurb: "Premium close-ups of the product or service in use, with a voiceover.",
    style: "Product hero film, commercial close-ups",
    speaker: "voiceover",
    direction:
      "A product hero film: premium commercial close-ups of the product or the service in action, real hands using it, textures and details, clean surfaces and controlled light, ending on the product in its best light. A voiceover carries the lines.",
  },
  {
    id: "before_after",
    label: "Before and after",
    blurb: "The frustrating 'before', then the transformed 'after'.",
    style: "Before and after transformation, live action",
    speaker: "either",
    direction:
      "A before-and-after ad: the first half shows the frustrating 'before' (muted, cramped, messy, stressed), the second half the same person or place 'after' (brighter, calmer, better), with a clear turning moment between them. Keep the same person, place and framing in matching before and after shots so the change reads instantly.",
  },
  {
    id: "pov_lifestyle",
    label: "POV / day in the life",
    blurb: "First-person or follow-cam moments from the customer's real day.",
    style: "POV lifestyle, day in the life",
    speaker: "voiceover",
    direction:
      "A POV / day-in-the-life ad: we see the customer's day through their eyes or just behind their shoulder, real moments in real places, the problem showing up naturally and the product or service fitting into the day. Warm natural light, a follow camera, a voiceover in the customer's own voice.",
  },
  {
    id: "animation_3d",
    label: "3D animation",
    blurb: "Stylised, friendly 3D animated characters and worlds.",
    style: "3D animated, stylised",
    speaker: "voiceover",
    direction:
      "A stylised 3D animated ad: friendly characters with simple, appealing shapes in a colourful, clean world, soft studio lighting, smooth expressive motion, clear visual metaphors for the problem and the solution. A voiceover carries the lines. No readable text or numbers drawn anywhere.",
  },
];

export const VIDEO_TYPE_IDS = VIDEO_TYPES.map((t) => t.id) as [VideoTypeId, ...VideoTypeId[]];

export function videoTypeOf(id: string | null | undefined): VideoType {
  return VIDEO_TYPES.find((t) => t.id === id) ?? VIDEO_TYPES[0]!;
}

/**
 * The creative direction for a video, from the chosen type and the operator's own idea, as one block
 * of text for the reader, writer and planner. Null when nothing was chosen or written.
 */
export function videoDirection(inputs: { videoType?: string | null; videoIdea?: string | null }): string | null {
  const type = videoTypeOf(inputs.videoType);
  const idea = inputs.videoIdea?.replace(/\s+/g, " ").trim();
  const parts: string[] = [];
  if (type.id !== "auto") {
    parts.push(`Video type chosen by the operator: ${type.label}. ${type.direction}`);
    if (type.speaker === "on_camera") parts.push("Who speaks: a person on camera, to the lens.");
    if (type.speaker === "voiceover") parts.push("Who speaks: an unseen voiceover; nobody talks to camera.");
  }
  if (idea) parts.push(`The operator's own idea for the video (follow it where it is filmable and fits the brand): ${idea}`);
  return parts.length ? parts.join("\n") : null;
}

/** The style a chosen type sets, or null to keep whatever the script or the writer chose. */
export function styleForType(id: string | null | undefined): string | null {
  return videoTypeOf(id).style || null;
}
