/**
 * What makes AI video footage look real, and what makes it look fake.
 *
 * Drawn from ByteDance's Seedance prompt guides (structured shot lists, one clear action per shot,
 * shot size / movement / focus named, positive descriptions with negatives kept for captions and
 * music) and from what practitioners report for AI video: generate no text at all and add real
 * lettering afterwards; a phone-shot look for UGC; simple hand actions; slow, motivated camera
 * moves; believable light and texture. Pure: strings and a few checks.
 */

export type StyleKind = "ugc" | "product" | "cinematic" | "action" | "documentary" | "lifestyle" | "motion" | "animated";

/** Which kind of footage a script's style describes. */
export function classifyStyle(style: string): StyleKind {
  const s = style.toLowerCase();
  if (/ugc|creator|selfie|phone|walkthrough|testimonial|talking head|to camera|tiktok|reel-style/.test(s)) return "ugc";
  if (/product|demo|unbox|packshot|hero shot|showcase|catalog/.test(s)) return "product";
  if (/motion graphic|kinetic|typograph|explainer/.test(s)) return "motion";
  if (/3d|animat|cartoon|illustrat|claymation/.test(s)) return "animated";
  if (/action|trailer|high[- ]energy|blockbuster/.test(s)) return "action";
  if (/document|interview|observational|news/.test(s)) return "documentary";
  if (/lifestyle|candid|day in the life|pov/.test(s)) return "lifestyle";
  return "cinematic";
}

/** The look of each kind of footage, written as positive description (negatives are kept for text and music). */
export const STYLE_LOOKS: Record<StyleKind, string> = {
  ugc: "Looks like a real person filmed it on their phone: held in one hand at about chest height, vertical, the person close to the lens, small natural handheld drift, slightly imperfect framing, ordinary daylight from a window or a lamp, soft phone-camera sharpness and fine grain. Real skin with visible pores and a little shine, ordinary clothes, a lived-in room with everyday clutter slightly out of focus. Natural blinking, small gestures, pauses and glances. Not studio lit, not symmetrical, not polished.",
  product: "A clean commercial product shot: one hero object, soft diffused key light with a gentle rim light, shallow depth of field, believable reflections and contact shadows on a real surface, tidy background. Slow, controlled camera movement (a gentle push-in or a slow orbit). Hands enter only to do one simple action with the product, with the fingers relaxed and apart.",
  cinematic: "Cinematic live-action: a 35mm lens look with shallow depth of field, motivated practical light (a window, a lamp, a screen glow) with soft contrast, subtle film grain, a restrained natural colour grade, layered foreground, subject and background. Slow dolly or slow handheld push, never a whip pan or a sudden zoom.",
  action: "Action-movie trailer look: anamorphic widescreen feel reframed for vertical, strong contrast and directional light (low sun, practical lamps, light through haze or dust), deep shadows with clean highlights, a cool-and-warm colour grade, fine film grain, real motion with weight and momentum (wind in clothes, dust, splashes, a door slamming), shots from low angles and close, energetic but readable camera moves (a tracking shot, a fast push-in, a crane-up), each shot built around one impact moment.",
  documentary: "Observational documentary: handheld at eye level with a slight natural sway, available light, a medium close interview framing, the subject looking just off the lens or to it, honest imperfect moments, natural pauses.",
  lifestyle: "Candid lifestyle footage: warm natural light, a handheld camera that follows the moment, real settings and everyday objects, relaxed natural movement, shallow depth of field.",
  motion: "Atmospheric background footage only: soft moving light, gentle gradients and drifting particles or out-of-focus shapes in the brand colours, slow movement, completely free of text, numbers or interface. All words and graphics are added afterwards.",
  animated: "Stylised 3D animation with soft studio lighting, simple clean shapes, smooth believable motion and a limited palette. No text, numbers or interface drawn anywhere.",
};

/**
 * What stops live-action footage looking generated: a real camera and lens, real light with a
 * source, and the small imperfections real footage has. Written positively, with the tell-tale AI
 * looks named once as things to avoid.
 */
export const REALISM_RULE =
  "Photographic realism, as if filmed by a real crew on a real camera (full-frame sensor, 35mm or 50mm lens, natural depth of field, true-to-life colour, fine film grain). Light comes from a real source in the scene (a window, a lamp, the sun) and falls off naturally. Skin has pores, fine lines and natural variation; hair has flyaways; clothes crease; surfaces show wear, dust and fingerprints; rooms have everyday clutter. People move with natural weight and timing, blink and breathe. It must not look like a 3D render, CGI, an illustration or a stock photo: no plastic or airbrushed skin, no waxy faces, no glossy over-sharpened HDR, no oversaturated colour, no perfectly symmetrical posed framing, no glowing rim light on everything.";

/** Realism applies to live action; stylised animation and motion backgrounds keep their own look. */
export function wantsRealism(style: string): boolean {
  const kind = classifyStyle(style);
  return kind !== "animated" && kind !== "motion";
}

/**
 * The rule that matters most. AI video models cannot spell: any screen, document, sign or label in
 * the frame comes out as convincing nonsense. So nothing readable is ever requested; every stat,
 * caption and screenshot is added afterwards with the real words.
 */
export const TEXT_FREE_RULE =
  "No readable text anywhere in the frame: no words, letters, numbers, charts, dashboards, user interfaces, documents, signs, labels, posters or logos. Where a screen, paper or sign has to be in the shot, keep it turned away from the camera, out of focus, or only a soft glow, and keep the camera on the person or the object.";

/** Hands, faces and motion are where AI footage breaks first, so the shots are kept simple. */
export const SIMPLE_ACTION_RULE =
  "One clear action per shot. Keep hand actions simple: one hand holding, pointing or gesturing, fingers relaxed and apart, nothing intricate. Keep the face steady and unobstructed while speaking. Camera movement is slow and has a reason; no whip pans, no sudden zooms, no fast cuts inside a shot.";

/** The action-trailer version: energy from the camera and the subject, still one clear action and simple hands. */
export const DYNAMIC_ACTION_RULE =
  "One clear, physically plausible action per shot, performed with energy and momentum. Keep hand actions simple, fingers relaxed and apart, nothing intricate. Keep a speaking face steady and unobstructed. Camera moves are energetic but readable: tracking, fast push-ins, low angles, a crane-up; a whip pan only at the very end of a shot as a transition. No shaky chaos, no morphing during fast motion.";

/** The action and camera rule for a style: dynamic for an action trailer, calm for everything else. */
export function actionRuleFor(style: string): string {
  return classifyStyle(style) === "action" ? DYNAMIC_ACTION_RULE : SIMPLE_ACTION_RULE;
}

/**
 * Guidance for whoever writes a scene's visual (the script writer, the scene rewriter, the uploaded
 * script reader). A visual is a filmable, text-free shot, never a screen to read.
 */
export const VISUAL_DIRECTION_RULES =
  "HOW TO WRITE EACH SCENE'S VISUAL (it becomes an AI video shot, which cannot render readable text): describe one filmable shot in the order shot size and angle, subject, ONE simple observable action, camera movement, light and setting. Choose the subjects, places and actions from THIS business's real world and THIS audience's real day: where the customer actually is when the problem or the result happens, what they actually handle, who is actually with them. Every scene must add something no other scene adds (a new fact, a new moment, a new emotion); never fill time with generic footage, and do not reuse the same room, the same framing or the same prop in consecutive scenes. NEVER make the visual a screen, dashboard, chart, spreadsheet, report, document, website, app, sign or label to be read, and never an invented interface, hologram or floating panel: the model draws those as garbled nonsense. If the point of a scene is a screen or a result, write the visual as the human moment around it (a reaction, a hand, a place, an object that belongs to the story). Never write that a screenshot, a figure, a caption, a logo or any graphic is added, composited or shown: the footage is the whole picture, and the video model draws whatever the visual mentions. Keep any recurring person the same in every scene they appear in. Prefer a specific, slightly unexpected detail over a generic one.";

const TEXT_RISK: Array<[RegExp, string]> = [
  [/\b(dashboard|screen ?recording|screen ?capture|full[- ]screen|screenshot|interface|\bui\b|\bux\b|spreadsheet|excel|analytics|admin panel)\b/i, "a dashboard or interface"],
  [/\b(chart|graph|infographic|bar chart|line chart|table|metrics?|kpis?|report|statement|invoice|receipt|contract|document|paperwork|pdf|certificate)\b/i, "a chart or document"],
  [/\b(website|web ?page|browser|search results?|google (ads|search)|app screen|laptop screen|monitor|computer screen|phone screen|on[- ]screen)\b/i, "a screen to read"],
  [/\b(sign|signage|billboard|poster|banner|label|packaging|menu|storefront|shopfront|licence plate|license plate|newspaper|headline|book cover|whiteboard|chalkboard|sticky notes?|handwritten|text overlay|caption|subtitle|lettering|typography)\b/i, "a sign, label or written text"],
  [/\b(logo|brand name|wordmark)\b/i, "a logo or brand name"],
];

/** What a visual shows that the video model would have to spell. Empty when it is safe. */
export function textRisk(visual: string): string[] {
  // A screen that is only a glow, or turned away or out of focus, shows nothing to misspell.
  const hidden = /(angled away|turned away|facing away|out of focus|blurred|not visible|soft glow|screen glow|glow from)/i.test(visual);
  const out: string[] = [];
  for (const [re, label] of TEXT_RISK) {
    if (hidden && (label === "a screen to read" || label === "a dashboard or interface")) continue;
    if (re.test(visual) && !out.includes(label)) out.push(label);
  }
  return out;
}

/** A shot that is mainly a screen to look at, rather than a person or an object with a screen somewhere in it. */
export function isScreenShot(visual: string): boolean {
  return /^(a |an |the )?(full[- ]screen|screen ?(recording|capture)|screenshot|close[- ]up of (a |the )?(screen|dashboard|laptop screen|monitor)|dashboard|analytics|chart|graph|report|spreadsheet|website)/i.test(visual.trim()) || /\b(screen ?recording|screen ?capture|full[- ]screen)\b/i.test(visual);
}

/**
 * LEGACY fallback, used only for a project that has no creative plan. A video made through the
 * planned pipeline never uses it: the planner chooses, per scene and per campaign, what is filmed
 * under a composited screenshot or figure (a fixed "person at a desk" shot repeated for every screen
 * scene is what made one ad show the same office for twenty seconds).
 */
export function substituteForScreenShot(hasPresenter: boolean): string {
  return hasPresenter
    ? "Medium close-up of the presenter at their desk, their face lit by a soft glow from a laptop angled away from the camera, glancing at it, then nodding slowly with a thoughtful expression"
    : "Slow close-up of hands resting on a desk beside a laptop angled away from the camera so the screen is not visible, soft screen glow on the desk, shallow depth of field";
}

/** The visual that is actually sent to the video model for a scene. */
export function clipVisual(visual: string, hasPresenter: boolean, hasGraphic: boolean): { text: string; changed: boolean } {
  const clean = visual.replace(/\s+/g, " ").trim();
  if (isScreenShot(clean) || (hasGraphic && textRisk(clean).length > 0 && /screen|dashboard|chart|report/i.test(clean))) {
    return { text: substituteForScreenShot(hasPresenter), changed: true };
  }
  return { text: clean, changed: false };
}
