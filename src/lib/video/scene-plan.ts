/**
 * The creative plan: a fresh, per-job design of the video, made from the real product, audience,
 * offer, platform, duration, assets and objective, and validated BEFORE any video generation call.
 *
 * This file holds reusable machinery only: the schema the planning model fills in, the prompt that
 * hands it the real inputs and the hard rules, a pure deterministic validator, the repair loop and
 * the single-scene redesign. It contains no storyboard, no company, no industry, no avatar, no
 * setting and no fixed scene count: every creative decision comes from the model, per job.
 */
import { generateObject } from "ai";
import { z } from "zod";
import { modelCandidates, withModelFallback } from "@/lib/video/model-fallback";
import { LANDING_PAUSE, WORDS_PER_SECOND, wordsIn } from "@/lib/video/timing";
import { CLEAN_PLAN_RULES, footageOnly, graphicReference, stripGraphicPhrases } from "@/lib/video/clean-mode";
import { REALISM_RULE, wantsRealism } from "@/lib/video/visual-rules";
import type {
  ApprovedClaim,
  CreativePlan,
  EditingNote,
  PlanCharacter,
  PlanEnvironment,
  PlanIssue,
  ProviderCapabilities,
  SceneBrief,
} from "@/lib/video/pipeline-types";

// ------------------------------------------------------------------ input

export type PlanScriptScene = {
  number: number;
  line: string;
  seconds: number;
  speaker: "on_camera" | "voiceover" | "none";
  keywords: string[];
  stat: string | null;
  assetId: string | null;
  visual: string;
  camera: string;
  sound: string;
};

export type PlanInput = {
  brandName: string;
  /** The longest one clip of the chosen video model can be: no scene may run longer. */
  maxSceneSeconds?: number;
  /** The kind of video and idea the operator asked for, as one direction block (absent when they left it to the AI). */
  direction?: string | null;
  product: string;
  audience: string;
  offer: string;
  platform: string;
  objective: string;
  targetSeconds: number;
  locale: string;
  script: {
    style: string;
    character: string | null;
    setting: string;
    scenes: PlanScriptScene[];
  };
  assets: Array<{ id: string; name: string; summary: string; stats: Array<{ value: string; label: string }> }>;
  claims: ApprovedClaim[];
  capabilities: ProviderCapabilities;
  maxSeconds: number;
  /**
   * "clean": the footage is the whole finished picture; nothing is composited and no scene may
   * describe a graphic. Left out, the earlier behaviour applies (graphics composited afterwards).
   */
  mode?: "clean" | "branded";
};

const isClean = (input: Pick<PlanInput, "mode">) => input.mode === "clean";

// ------------------------------------------------------------------ model schema

const transitionKinds = ["cut", "match_cut", "dissolve", "dip_to_colour"] as const;

export const sceneBriefModelSchema = z.object({
  number: z.number().int().describe("The script scene number this brief belongs to"),
  purpose: z.string().describe("What this scene is for in the story: the job it does for the viewer"),
  informationAdded: z.string().describe("The information or emotion this scene adds that no other scene adds"),
  narration: z.string().describe("The spoken words of this scene, copied verbatim from the script (empty if the script scene has none)"),
  subject: z.string().describe("The concrete thing or person the shot is about"),
  setting: z.string().describe("The specific place this shot happens in"),
  action: z.string().describe("ONE observable primary action that the subject performs"),
  framing: z.string().describe("Shot size and angle"),
  camera: z.string().describe("Camera movement, slow and motivated"),
  lighting: z.string().describe("The light: source, direction, colour, mood"),
  style: z.string().describe("The look and art direction of this shot"),
  characterId: z.string().nullable().describe("Id of a character from characters, or null when nobody recurring appears"),
  environmentId: z.string().describe("Id of an environment from environments"),
  requiredAssets: z
    .array(z.object({ assetId: z.string(), use: z.enum(["overlay_full", "overlay_inset"]) }))
    .describe("Uploaded assets the renderer composites in this scene (never drawn by the video model)"),
  overlays: z
    .array(
      z.object({
        kind: z.enum(["stat", "keyword", "cta", "url", "logo", "image"]),
        text: z.string().nullable(),
        claimId: z.string().nullable(),
        assetId: z.string().nullable(),
      }),
    )
    .describe("Everything the renderer draws on top: exact text and brand marks"),
  screenTreatment: z
    .enum(["none", "composite_verified_asset", "footage_without_screen"])
    .describe("How a screen or a result is handled; none only when the scene is not about a screen or result"),
  seconds: z.number().describe("Scene length in seconds, derived from the narration and the action"),
  durationBasis: z.string().describe("How the length was derived"),
  entry: z.object({ mode: z.enum(["cut", "continue_previous"]), condition: z.string() }),
  exit: z.object({ condition: z.string() }),
  transition: z.object({ kind: z.enum(transitionKinds), rationale: z.string() }),
  risks: z.array(z.string()).describe("What could go wrong when this shot is generated"),
  acceptance: z.array(z.string()).describe("Concrete things a reviewer can check on the finished clip"),
  editingNotes: z
    .array(
      z.object({
        kind: z.enum(["stat", "keyword", "cta", "url", "logo", "image", "end_card"]),
        text: z.string().nullable().describe("The exact wording suggested, when it is text"),
        claimId: z.string().nullable(),
        assetId: z.string().nullable(),
        position: z.string().nullable().describe("Where it could sit, in plain words"),
        note: z.string().nullable().describe("Why it is worth adding, or what to watch for"),
      }),
    )
    .describe("Optional suggestions for a person adding graphics by hand afterwards. Never sent to the video model. Empty when there is nothing worth adding."),
});

/** A plan written before editing notes existed, or by a model that left them out, simply has none. */
function withEditingNotes(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const fill = (scene: unknown) => (scene && typeof scene === "object" && !Array.isArray((scene as { editingNotes?: unknown }).editingNotes) ? { ...(scene as object), editingNotes: [] } : scene);
  const r = raw as { scenes?: unknown; scene?: unknown; voice?: unknown };
  // A plan without a voice (an older plan, or a model that left it out) gets one chosen for it when normalised.
  const voice = Array.isArray(r.scenes) && typeof r.voice !== "string" ? { voice: "" } : {};
  return { ...r, ...voice, ...(Array.isArray(r.scenes) ? { scenes: r.scenes.map(fill) } : {}), ...(r.scene ? { scene: fill(r.scene) } : {}) };
}

export const planModelSchema = z.object({
  narrative: z.object({
    approach: z.string().describe("The narrative and visual treatment chosen for this message"),
    whyItFits: z.string().describe("Why this treatment fits this product, audience, offer, platform and objective"),
    arc: z.array(z.string()).describe("The emotional or informational arc, beat by beat"),
  }),
  characters: z.array(z.object({ id: z.string(), description: z.string(), role: z.string() })),
  environments: z.array(z.object({ id: z.string(), description: z.string(), sceneNumbers: z.array(z.number().int()) })),
  voice: z
    .string()
    .describe("The ONE voice for every spoken line in the ad, on camera or off: gender, rough age, timbre and pitch, accent, pace and energy, in one sentence. It is repeated word for word in every clip so the voice never changes."),
  scenes: z.array(sceneBriefModelSchema),
});

export type PlanModelOutput = z.infer<typeof planModelSchema>;

// ------------------------------------------------------------------ prompt

function listAssets(input: PlanInput): string {
  if (!input.assets.length) return "None uploaded.";
  return input.assets
    .map((a) => `- id "${a.id}" (${a.name}): ${a.summary || "no description"}${a.stats.length ? `. Figures printed in it: ${a.stats.map((s) => `${s.value} ${s.label}`).join("; ")}` : ""}`)
    .join("\n");
}

function listClaims(input: PlanInput): string {
  if (!input.claims.length) return "None approved. Do not show or imply any figure, proof or credential.";
  return input.claims.map((c) => `- id "${c.id}" [${c.kind}]: ${c.text}${c.figure ? ` (figure ${c.figure})` : ""}`).join("\n");
}

function listCapabilities(c: ProviderCapabilities, clean = false): string {
  const gaps = clean ? c.gaps.filter((g) => !/composit/i.test(g)) : c.gaps;
  return [
    `reference images for a recurring character: ${c.referenceImages ? "yes" : "no"}`,
    `first and last frame control: ${c.firstLastFrame ? "yes" : "no"}`,
    `voice generated by the video model itself: ${c.nativeAudio ? "yes" : "no"}`,
    `lip-sync: ${c.lipSync} (checked afterwards, not controlled)`,
    ...(clean ? [] : [`perspective tracking of a screen inside footage: ${c.perspectiveScreenTracking ? "yes" : "no"}`]),
    gaps.length ? `known gaps: ${gaps.join("; ")}` : "known gaps: none reported",
  ].join("\n");
}

function listScript(input: PlanInput): string {
  const clean = isClean(input);
  return input.script.scenes
    .map((s) => {
      // In a clean video nothing is shown on screen: what the script marked for display is only material for an editing note.
      const marked = [s.stat ? `figure "${s.stat}"` : null, s.assetId ? `evidence file ${s.assetId}` : null, s.keywords.length ? `phrases ${s.keywords.join(", ")}` : null].filter(Boolean).join("; ");
      const bits = [
        `Scene ${s.number} (${s.seconds}s, speaker ${s.speaker}${secondsNeeded(s.line, s.speaker) ? `; its words need at least ${Math.ceil(secondsNeeded(s.line, s.speaker))}s to say` : ""})`,
        clean ? `  spoken line (heard, never displayed): ${s.line ? `"${s.line}"` : "(none)"}` : `  spoken line: ${s.line ? `"${s.line}"` : "(none)"}`,
        !clean && s.keywords.length ? `  keywords highlighted: ${s.keywords.join(", ")}` : null,
        !clean && s.stat ? `  stat to show: ${s.stat}` : null,
        !clean && s.assetId ? `  uploaded asset to show: ${s.assetId}` : null,
        clean && marked ? `  material for an optional editing note only (never part of the footage): ${marked}` : null,
        clean && graphicReference(s.visual)
          ? "  the script writer's visual idea referred to a graphic or a screenshot, which does not exist in a clean video: design this shot from the spoken line"
          : `  the script writer's rough visual idea (a starting point you may replace): ${s.visual}`,
        `  rough camera idea: ${s.camera}`,
        s.sound ? `  sound: ${s.sound}` : null,
      ];
      return bits.filter((b): b is string => b !== null).join("\n");
    })
    .join("\n");
}

const SCENE_FIELDS = [
  "number (the script scene's number)",
  "purpose: what the scene is for in the story",
  "informationAdded: the information or emotion this scene adds that no other scene adds",
  "narration: the scene's spoken line copied verbatim from the script",
  "subject: the concrete person or thing the shot is about",
  "setting: the specific place",
  "action: ONE observable primary action",
  "framing: shot size and angle",
  "camera: movement, slow and motivated",
  "lighting",
  "style: look and art direction",
  "characterId and environmentId: continuity ids from your characters and environments lists (characterId may be null)",
  "requiredAssets: uploaded assets this scene needs, with how each is used (overlay_full or overlay_inset)",
  "overlays: everything the renderer draws on top (stat with its claimId, keyword, cta, url, logo, image with its assetId)",
  "screenTreatment: none, composite_verified_asset or footage_without_screen",
  "seconds and durationBasis: derived from the narration and the action, not rounded to fit a template",
  "entry (cut or continue_previous, with the condition) and exit condition",
  "transition (kind and the reason for it) to the next scene",
  "risks: what could go wrong when the shot is generated",
  "acceptance: concrete checks a reviewer can run on the finished clip",
];

const EDITING_NOTES_FIELD = "editingNotes: optional suggestions for a person adding graphics by hand afterwards (kind, exact text, claimId, assetId, position, note); an empty list when there is nothing worth adding";

/** The same fields for a clean video: the two that list composited graphics must stay empty, and suggestions go in editingNotes. */
const CLEAN_SCENE_FIELDS = [
  ...SCENE_FIELDS.map((f) =>
    f.startsWith("requiredAssets")
      ? "requiredAssets: always an empty list (nothing is composited in a clean video)"
      : f.startsWith("overlays")
        ? "overlays: always an empty list (nothing is drawn on top in a clean video)"
        : f.startsWith("screenTreatment")
          ? "screenTreatment: footage_without_screen when the scene is about a screen or a result, otherwise none"
          : f.startsWith("acceptance")
            ? "acceptance: concrete checks a reviewer can run on the finished clip, about the filmed footage only"
            : f,
  ),
  EDITING_NOTES_FIELD,
];

/** The creative bar: one specific idea carried through the ad, not a sequence of stock shots. */
export const CONCEPT_RULE =
  "Build the ad on ONE fresh central idea that belongs to this business and this audience: a specific situation, contrast or visual metaphor from the customer's real day (name it in narrative.approach). Every scene expresses that idea in a concrete, slightly unexpected but believable way: a particular place, prop, gesture or moment a viewer has not seen in a hundred other ads. Reject the first idea anyone would have (a person smiling at a laptop, a handshake, a thumbs up, pointing at the camera in an office, a team high-five, a city skyline). The opening scene stops the scroll with something visually specific within the first second.";

/** One voice from the first word to the last. */
export const VOICE_RULE =
  "Choose ONE voice for the whole ad in the voice field (gender, rough age, timbre and pitch, accent, pace, energy). If a recurring person speaks on camera, it is that person's voice, and any voiceover is the same person. Never describe a different voice for a later scene.";

const HARD_RULES = [
  "The video model must NEVER draw readable text, logos, user interfaces, dashboards, charts or numbers: it renders them as convincing nonsense. Those are composited by the renderer from verified assets and approved claims. A scene that is about a screen, a dashboard, a report or a result must say how it is handled: composite_verified_asset (the verified asset is laid over footage you choose to fit it, and it must be listed in requiredAssets) or footage_without_screen (the footage never shows the screen; the idea is carried another way).",
  "Reject interchangeable filler. Every scene earns its place with something new to say or feel; if two scenes could swap without the viewer noticing, redesign one.",
  "Reject repetitive typing or scrolling shots, arbitrary holograms and floating dashboards or interfaces, stock-office montage, glowing-screen B-roll, and cardboard or abstract UI objects. An unrelated dashboard is worse than none.",
  "Vary the setting, framing and subject whenever that strengthens the story, while keeping the character, lighting, art direction and screen direction coherent from scene to scene. Do not stay in one place for the whole video without a story reason.",
  "Avoid actions that generate badly: touching or covering the face, overlapping or interlaced hands, rapid head turns, elaborate finger work (counting on fingers, pinching), handing objects over. If one is essential, give the scene a stronger acceptance check that names the risk.",
  "One primary action per scene. Do not chain actions with 'then' or 'and then'.",
  "Only mark an entry as continue_previous when the same character AND the same environment genuinely continue from the previous scene. Never force unrelated scenes to share an ending frame; use a cut instead.",
  "Use only the asset ids and claim ids listed above. Every figure shown on screen must come from an approved claim and be referenced by its claim id. Do not invent figures, proof or credentials.",
  "Every scene's narration is copied from the script exactly, character for character. Do not rewrite, add or drop spoken words.",
  "A scene's seconds must be long enough to say its narration at a natural pace (about " + WORDS_PER_SECOND + " words a second plus a short landing pause) and to complete its one action; do not hold a shot far longer than its speech needs. The total must stay within the maximum.",
  "A non-cut transition needs a rationale tied to the story. Do not dissolve or dip between every scene for decoration.",
  "Every scene lists its generation risks and at least one concrete acceptance check.",
];

/** The hard rules that apply: a clean video swaps the two rules about composited graphics for the clean-video rules. */
export function hardRulesFor(input: Pick<PlanInput, "mode"> & { script?: Pick<PlanInput["script"], "style"> }): string[] {
  // Realism is asked of live action only; a stylised animation keeps its own look.
  const craft = [CONCEPT_RULE, VOICE_RULE, ...(!input.script || wantsRealism(input.script.style) ? [`Every shot is written to look real: ${REALISM_RULE}`] : [])];
  if (!isClean(input)) return [...craft, ...HARD_RULES];
  const kept = HARD_RULES.filter((r) => !r.startsWith("The video model must NEVER draw readable text") && !r.startsWith("Use only the asset ids and claim ids"));
  return [
    ...craft,
    ...CLEAN_PLAN_RULES,
    "The video model cannot spell: any readable text, logo, interface, dashboard, chart or number it is asked for comes out as convincing nonsense. A scene whose line is about a screen, a report or a result carries the idea through a person, a place or an object, and never shows a screen with content.",
    "An editing note that carries a figure must cite the approved claim it comes from by its claim id, and an editing note that refers to an uploaded file must use its asset id. Do not invent figures, proof or credentials.",
    ...kept,
  ];
}

/** The planning prompt: the real inputs, the choices the model must make, the fields and the hard rules. */
export function planPrompt(input: PlanInput, repair?: PlanIssue[]): string {
  const clean = isClean(input);
  const parts: string[] = [
    "You are the creative director for one short video ad. Design the creative plan for THIS ad from the inputs below. The plan is checked automatically before any video is generated, and anything that fails is sent back to you.",
    [
      "INPUTS",
      `Brand: ${input.brandName}`,
      `Product or service: ${input.product}`,
      `Audience: ${input.audience}`,
      `Offer: ${input.offer}`,
      `Platform: ${input.platform}`,
      `Objective: ${input.objective}`,
      `Target length: about ${input.targetSeconds} seconds. Hard maximum: ${input.maxSeconds} seconds.`,
      `Language and locale: ${input.locale}`,
      input.direction ? `THE KIND OF VIDEO THE OPERATOR ASKED FOR (the treatment you choose must deliver this; it overrides the default calm camera where it asks for energy):\n${input.direction}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
    clean
      ? `UPLOADED EVIDENCE (never shown in this video and never recreated or imitated by it; listed only so you know what the claims rest on and can refer to a file in an editing note)\n${listAssets(input)}`
      : `UPLOADED ASSETS (the renderer can composite these; each may be shown only as described)\n${listAssets(input)}`,
    clean
      ? `APPROVED CLAIMS (the only figures, proof and credentials an editing note may carry)\n${listClaims(input)}`
      : `APPROVED CLAIMS (the only figures, proof and credentials that may appear)\n${listClaims(input)}`,
    `VIDEO MODEL ${clean ? "" : "AND RENDERER "}CAPABILITIES\n${listCapabilities(input.capabilities, clean)}`,
    [
      "THE SCRIPT (the spoken lines are fixed; the visuals are yours to design)",
      `Script style: ${clean ? stripGraphicPhrases(input.script.style) || "live action" : input.script.style}`,
      `Script's recurring person: ${input.script.character ?? "nobody recurring"}`,
      `Script's overall setting idea: ${input.script.setting}`,
      listScript(input),
    ].join("\n"),
    [
      "YOUR TASK",
      "1. Choose the narrative approach and visual treatment that fits THIS message, audience, offer and platform. It must not default to a problem-and-solution office montage; pick what suits the inputs and say why it fits.",
      "2. Define the recurring characters (if any) and the environments the story uses. Give every environment the scene numbers that happen in it.",
      "3. Choose the one voice for the whole ad (the voice field).",
      "4. Write one brief for every scene listed in the script, using the same scene numbers. Each brief has exactly these fields:",
      ...(clean ? CLEAN_SCENE_FIELDS : SCENE_FIELDS).map((f) => `   - ${f}`),
    ].join("\n"),
    `HARD RULES\n${hardRulesFor(input)
      .map((r, i) => `${i + 1}. ${r}`)
      .join("\n")}`,
  ];

  if (repair?.length) {
    parts.push(
      [
        "YOUR PREVIOUS PLAN WAS CHECKED AND THESE PROBLEMS WERE FOUND. Fix exactly these problems and keep everything that already works.",
        ...repair.map((i) => `- ${i.severity.toUpperCase()}${i.scene !== null ? ` (scene ${i.scene})` : ""} [${i.code}]: ${i.message}`),
        "Return the complete corrected plan, not only the changed parts.",
      ].join("\n"),
    );
  }
  return parts.join("\n\n");
}

// ------------------------------------------------------------------ validation helpers

/** Two informationAdded texts whose word overlap (Jaccard) is at or above this are the same point made twice. */
export const INFO_SIMILARITY_THRESHOLD = 0.6;
/** Two setting texts at or above this overlap are treated as the same place even with different ids. */
export const SETTING_SIMILARITY_THRESHOLD = 0.7;
/** More scenes than this in a row in one environment is a repeated setting (error). */
export const MAX_CONSECUTIVE_SAME_ENVIRONMENT = 3;
/** From this many scenes, one environment holding more than this share of them is a repeated setting (error). */
export const MAX_ENVIRONMENT_SHARE = 0.6;
export const MIN_SCENES_FOR_SHARE_CHECK = 5;
/** Framing and subject overlap at or above this, back to back, is the same shot repeated (warning). */
export const SAME_SHOT_SIMILARITY_THRESHOLD = 0.7;
/** A spoken scene held longer than this multiple of what its words need is a dead hold (warning)... */
export const DEAD_HOLD_FACTOR = 2.5;
/** ...but only when the surplus is also more than this many seconds, so very short lines are not flagged. */
export const DEAD_HOLD_MIN_SURPLUS = 2;
/** Non-cut transitions on more than this share of scenes (and at least 3) are decoration (warning). */
export const DECORATIVE_TRANSITION_SHARE = 0.5;

const STOP = new Set(["the", "and", "that", "this", "with", "for", "are", "was", "his", "her", "their", "its", "from", "into", "than", "then", "they", "them", "you", "your", "our", "has", "have", "had", "who", "what", "how", "why", "shows", "show", "scene", "viewer"]);

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOP.has(t)),
  );
}

function jaccard(a: string, b: string): number {
  const x = tokens(a);
  const y = tokens(b);
  if (!x.size || !y.size) return 0;
  let inter = 0;
  for (const t of x) if (y.has(t)) inter += 1;
  return inter / (x.size + y.size - inter);
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const blank = (s: unknown) => typeof s !== "string" || !norm(s);

/** Words in the purpose text that explain why a normally weak pattern is deliberate. Needs real explanation length too. */
const JUSTIFIED = /\b(because|justified|deliberately|intentionally|on purpose)\b/i;

type Pattern = { code: string; label: string; re: RegExp };

/** Patterns that read as filler or fail in generation. Matched on subject, action and setting. */
const FILLER_PATTERNS: Pattern[] = [
  { code: "filler_typing", label: "generic typing or scrolling on a laptop or phone", re: /\b(typing|types|typed|scrolling|scrolls)\b.{0,40}\b(laptop|keyboard|computer|screen|phone|desktop)\b|\b(laptop|keyboard|computer|phone)\b.{0,30}\b(typing|scrolling)\b|\bhands? (on|at) (a |the )?keyboard\b/i },
  { code: "filler_hologram", label: "a floating or holographic dashboard or interface", re: /\bholo(gram|graphic|grams)\w*|\bfloating (dashboards?|interfaces?|ui|screens?|panels?|charts?|graphs?|data|numbers?)\b|\b(dashboards?|interfaces?|charts?|graphs?|panels?) (floating|hovering)\b|\bhovering (dashboards?|interfaces?|screens?|panels?)\b/i },
  { code: "filler_stock_office", label: "a stock office montage", re: /\bstock (office|footage|montage)\b|\boffice montage\b|\bcorporate montage\b|\bgeneric office\b|\bbusy open[- ]plan office\b|\bteam (high[- ]fiv\w+|clapping|celebrating around)\b/i },
  { code: "filler_glow_screen", label: "glowing-screen B-roll", re: /\bglowing (laptop |computer |monitor |phone |tablet )?screens?\b|\bscreen glow\b|\bglow (from|of) (a |the )?(laptop|monitor|screen)\b/i },
  { code: "filler_ui_object", label: "a cardboard, paper or abstract UI object", re: /\b(cardboard|paper|foam|cut-?out)\b.{0,30}\b(ui|interface|dashboard|screen|app|chart)\b|\b(abstract|generic|blank|placeholder) (ui|interface|dashboard|app screen)\b/i },
];

/** True when the match is negated just before it ("no floating dashboard", "without typing"). */
function negatedAt(text: string, index: number): boolean {
  return /\b(no|not|never|without|avoid|instead of)\s+(\w+\s+){0,2}$/i.test(text.slice(Math.max(0, index - 30), index));
}

const SCREEN_WORDS = /\b(screens?|dashboards?|charts?|graphs?|reports?|spreadsheets?|analytics|interface|web ?site|web ?page)\b/i;
const RESULT_WORDS = /\b(results?|metrics?|numbers?|stats?|figures?|percent|roi|roas)\b/i;
const VISUAL_TEXT_RISK = /\b(dashboards?|charts?|graphs?|spreadsheets?|reports?|interface|logos?|readable text|text on (the )?screen|numbers on (the )?screen)\b/i;

type Risk = { code: string; label: string; re: RegExp; accept: RegExp[] };

const RISKY_ACTIONS: Risk[] = [
  { code: "risk_face_touch", label: "touching the face", re: /\b(touch(es|ing)?|rub(s|bing)?|scratch(es|ing)?|wipe(s|ing)?|adjust(s|ing)?|pinch(es|ing)?) (her|his|their|the|own|one's|a)?\s?(face|eyes?|nose|mouth|chin|cheeks?|forehead|glasses|hair|lips?)\b/i, accept: [/\b(face|facial|features?)\b/i, /\b(hand|finger|touch|contact|distort|warp|morph|obstruct|cover)/i] },
  { code: "risk_cover_face", label: "covering the face", re: /\bcover(s|ing)?\b.{0,20}\b(face|mouth|eyes)\b|\bhands? (over|on|covering) (her|his|their|the) (face|mouth|eyes)\b|\bhides? (her|his|their )?face\b/i, accept: [/\b(face|facial|features?)\b/i, /\b(cover|obstruct|hidden|visible|hand|distort|morph)/i] },
  { code: "risk_overlap_hands", label: "overlapping or interlaced hands", re: /\b(overlapping|interlac\w+|interlock\w*|clasp\w*|clench\w*|intertwin\w*|crossed) (hands|fingers)\b|\bhands (overlap\w*|clasp\w*|together|intertwin\w*)\b|\bfingers (interlac\w+|intertwin\w+|laced)\b/i, accept: [/\b(hands?|fingers?)\b/i, /\b(overlap|interlac|intertwin|merge|fuse|distinct|separate|anatom|count|extra)/i] },
  { code: "risk_head_turn", label: "a rapid head turn", re: /\b(rapid|quick|sudden|fast|whip)\w* (head )?(turn|turns|spin|snap)\w*|\bhead (snap|whip|spin)\w*|\bquickly turns? (her |his |their )?head\b/i, accept: [/\b(head|face)\b/i, /\b(turn|profile|identity|consisten|morph|warp|same)/i] },
  { code: "risk_finger_gesture", label: "an elaborate finger gesture", re: /\bcount(s|ing)? (it |them |off )?(on )?(her |his |their |with )?(fingers|one|two|three)\b|\bfingers? (count|gesture|snap|point)\w*|\b(holds?|holding|raises?|raising) up (one|two|three|four|five|\d) fingers\b|\bpinch(es|ing)\b|\bair quotes\b|\bpeace sign\b/i, accept: [/\b(fingers?|hands?)\b/i, /\b(count|five|digit|shape|anatom|distinct|extra|merge)/i] },
  { code: "risk_hand_over", label: "handing an object over", re: /\bhand(s|ing)? (over|off)\b|\bhand(s|ing)? (him|her|them|me|it)\b|\bhand(s|ing)? (the|a|an) (\w+ ){1,2}(to|over)\b|\bpass(es|ing)? (a|an|the|it|something) (to|across)\b|\bexchang(e|es|ing)\b|\bgives? (him|her|them) (a|an|the)\b/i, accept: [/\b(hands?|object|item|exchange|pass|transfer)\b/i, /\b(intact|clean|consisten|morph|merge|warp|disappear|clip|distort|anatom)/i] },
];

const ACTION_VERB = /^(\w+ing|\w+ed|looks?|turns?|nods?|smiles?|walks?|picks?|puts?|opens?|closes?|reaches?|points?|holds?|sits?|stands?|steps?|glances?|shakes?|waves?|takes?|leans?|laughs?|writes?|speaks?|pulls?|pushes?|lifts?|sets?|places?)\b/i;

/** How many separate primary actions an action text seems to hold; 1 is fine. */
function actionCount(action: string): { multi: boolean; why: string } {
  const a = action.toLowerCase();
  if (/\bthen\b/.test(a)) return { multi: true, why: 'it chains actions with "then"' };
  if ((a.match(/\bwhile\b/g) ?? []).length >= 2) return { multi: true, why: 'it has more than one "while"' };
  const andVerbs = (a.match(/\band\s+\w+(\s+\w+)?/g) ?? []).filter((m) => {
    const rest = m.replace(/^and\s+/, "");
    return ACTION_VERB.test(rest) || /^\w+\s+(it|the|a|an|her|his|their|them|up|down|over|out|off|on|in|at|to)$/.test(rest);
  }).length;
  if (andVerbs > 2) return { multi: true, why: `it joins ${andVerbs + 1} verbs with "and"` };
  return { multi: false, why: "" };
}

function figuresIn(text: string): string[] {
  return (text.match(/\d[\d,.]*/g) ?? []).map((n) => n.replace(/,/g, "").replace(/[.]+$/, "")).filter(Boolean);
}

/** A simple figure compare: every number printed in `text` appears in the claim's figure or text. Another module does the strict check. */
function unbackedFigures(text: string, claim: ApprovedClaim): string[] {
  const allowed = new Set(figuresIn(`${claim.figure ?? ""} ${claim.text}`));
  return figuresIn(text).filter((f) => !allowed.has(f));
}

// ------------------------------------------------------------------ validation

export type ValidateCtx = {
  scriptScenes: PlanInput["script"]["scenes"];
  assetIds: string[];
  claimIds: string[];
  maxSeconds: number;
  capabilities?: ProviderCapabilities;
  /** When given, stat overlays are checked against the referenced claim's figure. */
  claims?: ApprovedClaim[];
  /** "clean": no scene may describe a graphic, and the last scene must end the film naturally. */
  mode?: "clean" | "branded";
};

/** The fields of a brief that are handed to the video model as a description of the footage. */
const FOOTAGE_FIELDS: Array<[(b: SceneBrief) => string, string]> = [
  [(b) => b.subject, "subject"],
  [(b) => b.setting, "setting"],
  [(b) => b.action, "action"],
  [(b) => b.framing, "framing"],
  [(b) => b.camera, "camera"],
  [(b) => b.lighting, "lighting"],
  [(b) => b.exit?.condition ?? "", "exit condition"],
];

const FROZEN_ENDING = /\b(freeze[- ]?frames?|frozen|held frame|holds? on a (still|frozen)|still frame|end[- ]?card|cuts? to (a |the )?(card|logo|text|black))\b/i;
const DEAD_STILL = /\b(no movement|completely still|motionless|does not move|without moving|perfectly still)\b/i;
/** A shot this long with nothing moving in it reads as a frozen picture. */
export const STATIC_SHOT_SECONDS = 5;

/**
 * Check a plan against its script and inputs. Pure and deterministic. "error" issues block video
 * generation; "warning" issues are shown and sent back to the planner but do not block.
 */
export function validatePlan(plan: Omit<CreativePlan, "validation">, ctx: ValidateCtx): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const add = (scene: number | null, code: string, severity: "error" | "warning", message: string) => issues.push({ scene, code, severity, message });

  const briefs = plan.scenes;
  const characterIds = new Set(plan.characters.map((c) => c.id));
  const environmentIds = new Set(plan.environments.map((e) => e.id));
  const assetIds = new Set(ctx.assetIds);
  const claimIds = new Set(ctx.claimIds);
  const claimById = new Map((ctx.claims ?? []).map((c) => [c.id, c]));
  const clean = ctx.mode === "clean";

  // --- coverage: exactly one brief per script scene, narration verbatim
  const scriptByNumber = new Map(ctx.scriptScenes.map((s) => [s.number, s]));
  for (const s of ctx.scriptScenes) {
    const matching = briefs.filter((b) => b.number === s.number);
    if (matching.length === 0) add(s.number, "scene_missing", "error", `Script scene ${s.number} has no brief. Add exactly one brief with number ${s.number}.`);
    else if (matching.length > 1) add(s.number, "scene_duplicate", "error", `Script scene ${s.number} has ${matching.length} briefs. Keep exactly one.`);
  }
  for (const b of briefs) {
    if (!scriptByNumber.has(b.number)) add(b.number, "scene_unknown", "error", `Brief number ${b.number} does not match any script scene. Remove it or fix its number.`);
  }

  const seenNumbers = new Set<number>();
  const ordered = [...briefs].sort((a, b) => a.number - b.number);

  for (const b of ordered) {
    const s = scriptByNumber.get(b.number);
    const n = b.number;
    const firstOfNumber = !seenNumbers.has(n);
    seenNumbers.add(n);

    // narration verbatim
    if (s && firstOfNumber && norm(b.narration ?? "") !== norm(s.line)) {
      add(n, "narration_mismatch", "error", `Scene ${n}'s narration must be the script line exactly: "${s.line}". Copy it verbatim; do not rewrite, add or drop words.`);
    }

    // required text fields
    const required: Array<[keyof SceneBrief, string]> = [
      ["purpose", "purpose"],
      ["informationAdded", "informationAdded"],
      ["subject", "subject"],
      ["setting", "setting"],
      ["action", "action"],
      ["framing", "framing"],
      ["camera", "camera"],
      ["lighting", "lighting"],
    ];
    for (const [key, label] of required) {
      if (blank(b[key])) add(n, `empty_${label}`, "error", `Scene ${n} has no ${label}. Write a concrete, specific ${label} for this scene.`);
    }

    // filler and clichés, unless the purpose clearly justifies them
    const visualText = `${b.subject} ${b.action} ${b.setting}`;
    const justified = JUSTIFIED.test(b.purpose ?? "") && norm(b.purpose ?? "").length >= 40;
    for (const p of FILLER_PATTERNS) {
      const m = p.re.exec(visualText);
      if (m && !negatedAt(visualText, m.index) && !justified) {
        add(n, p.code, "error", `Scene ${n} shows ${p.label}, which is interchangeable filler and explains nothing. Replace it with a shot specific to this product and message, or state in the purpose why this exact shot is deliberate and necessary.`);
      }
    }

    // screens, dashboards and results
    const spoken = `${b.narration ?? ""} ${b.purpose ?? ""}`;
    const hasStatOverlay = (b.overlays ?? []).some((o) => o.kind === "stat");
    const aboutScreen =
      SCREEN_WORDS.test(spoken) ||
      (RESULT_WORDS.test(spoken) && Boolean(s?.stat || s?.assetId || hasStatOverlay)) ||
      (b.requiredAssets ?? []).length > 0 ||
      hasStatOverlay;
    if (clean) {
      // The footage is the whole picture: a field that mentions a graphic makes the video model draw one.
      for (const [get, label] of FOOTAGE_FIELDS) {
        const hit = graphicReference(get(b) ?? "");
        if (hit) add(n, "graphic_in_footage", "error", `Scene ${n}'s ${label} mentions "${hit}". In a clean video nothing is added to the picture, and the video model draws whatever the description mentions. Describe only what the camera films (people, places, objects, movement, light) and move any suggestion for a graphic to editingNotes.`);
      }
      if ((b.requiredAssets ?? []).length || (b.overlays ?? []).length) add(n, "graphics_listed", "error", `Scene ${n} lists requiredAssets or overlays. A clean video has none: leave both empty and put suggestions in editingNotes.`);
      const risky = VISUAL_TEXT_RISK.exec(visualText);
      if (risky && !negatedAt(visualText, risky.index)) add(n, "text_in_footage", "error", `Scene ${n}'s footage description includes something the video model would have to draw as readable text or interface (${risky[0]}). Carry the idea through a person, a place or an object instead; never show a screen with content.`);
      if (b.seconds >= STATIC_SHOT_SECONDS && DEAD_STILL.test(b.action ?? "")) add(n, "static_shot", "warning", `Scene ${n} holds for ${b.seconds}s with nothing moving, which reads as a frozen picture. Give the person a small natural action (a breath, a shift of weight, a slight nod) while the camera stays calm.`);
      for (const note of b.editingNotes ?? []) {
        if (note.assetId && !assetIds.has(note.assetId)) add(n, "unknown_asset", "error", `Scene ${n} has an editing note for file "${note.assetId}", which was not uploaded. Use only these asset ids: ${ctx.assetIds.join(", ") || "(none)"}.`);
        if (note.claimId && !claimIds.has(note.claimId)) add(n, "unknown_claim", "error", `Scene ${n} has an editing note citing claim "${note.claimId}", which is not an approved claim. Use only these claim ids: ${ctx.claimIds.join(", ") || "(none)"}.`);
        if (note.text && figuresIn(note.text).length && note.kind !== "url") {
          const claim = note.claimId ? claimById.get(note.claimId) : undefined;
          if (!note.claimId) add(n, "stat_without_claim", "error", `Scene ${n} suggests the figure "${note.text}" without citing an approved claim. Reference the claim id that supports it, or remove the figure.`);
          else if (claim && unbackedFigures(note.text, claim).length) add(n, "stat_unsupported", "error", `Scene ${n}'s editing note "${note.text}" contains ${unbackedFigures(note.text, claim).join(", ")}, which claim ${claim.id} ("${claim.text}") does not support. Use the claim's own figure exactly.`);
        }
      }
      if ((b.editingNotes ?? []).length > 2) add(n, "too_many_notes", "warning", `Scene ${n} suggests ${(b.editingNotes ?? []).length} graphics. Keep at most two, where emphasis genuinely helps; not every spoken sentence needs a headline.`);
    }
    if (!clean && aboutScreen && b.screenTreatment === "none") {
      add(n, "screen_treatment_missing", "error", `Scene ${n} is about a screen, a report or a result (or carries an asset or stat) but its screenTreatment is "none". Choose composite_verified_asset (list the asset in requiredAssets) or footage_without_screen, and say how the footage fits.`);
    }
    if (b.screenTreatment === "composite_verified_asset" && !(b.requiredAssets ?? []).length) {
      add(n, "composite_without_asset", "error", `Scene ${n} says composite_verified_asset but lists no requiredAssets. Name the uploaded asset the renderer will lay over the footage, or switch to footage_without_screen.`);
    }
    if (!clean && b.screenTreatment === "none" && VISUAL_TEXT_RISK.test(visualText) && !negatedAt(visualText, VISUAL_TEXT_RISK.exec(visualText)?.index ?? 0)) {
      add(n, "text_in_footage", "error", `Scene ${n}'s footage description includes something the video model would have to draw as readable text or interface (${VISUAL_TEXT_RISK.exec(visualText)?.[0]}). Describe footage without it; the renderer adds verified text, logos and screens on top.`);
    }
    if (!clean && s?.assetId && !(b.requiredAssets ?? []).some((r) => r.assetId === s.assetId)) {
      add(n, "asset_not_used", "warning", `The script puts asset ${s.assetId} in scene ${n} but the brief does not list it in requiredAssets. Add it with how it is used, or explain why it is dropped.`);
    }

    // ids
    for (const r of b.requiredAssets ?? []) {
      if (!assetIds.has(r.assetId)) add(n, "unknown_asset", "error", `Scene ${n} requires asset "${r.assetId}", which was not uploaded. Use only these asset ids: ${ctx.assetIds.join(", ") || "(none)"}.`);
    }
    for (const o of b.overlays ?? []) {
      if (o.assetId && !assetIds.has(o.assetId)) add(n, "unknown_asset", "error", `Scene ${n} has an overlay using asset "${o.assetId}", which was not uploaded. Use only these asset ids: ${ctx.assetIds.join(", ") || "(none)"}.`);
      if (o.claimId && !claimIds.has(o.claimId)) add(n, "unknown_claim", "error", `Scene ${n} has an overlay citing claim "${o.claimId}", which is not an approved claim. Use only these claim ids: ${ctx.claimIds.join(", ") || "(none)"}.`);
      if (o.kind === "image" && !o.assetId) add(n, "overlay_image_no_asset", "warning", `Scene ${n} has an image overlay with no assetId. Name the uploaded asset to show.`);
      if (o.kind === "stat" && o.text) {
        const figures = figuresIn(o.text);
        if (figures.length) {
          if (!o.claimId) {
            add(n, "stat_without_claim", "error", `Scene ${n} shows the figure "${o.text}" without citing an approved claim. Reference the claim id that supports it, or remove the figure.`);
          } else {
            const claim = claimById.get(o.claimId);
            if (claim) {
              const bad = unbackedFigures(o.text, claim);
              if (bad.length) add(n, "stat_unsupported", "error", `Scene ${n}'s stat overlay "${o.text}" contains ${bad.join(", ")}, which claim ${claim.id} ("${claim.text}") does not support. Use the claim's own figure exactly.`);
            }
          }
        }
      }
    }
    if (b.characterId && !characterIds.has(b.characterId)) add(n, "unknown_character", "error", `Scene ${n} uses character "${b.characterId}", which is not in characters. Add it to characters or use one that is listed.`);
    if (b.environmentId && !environmentIds.has(b.environmentId)) add(n, "unknown_environment", "error", `Scene ${n} uses environment "${b.environmentId}", which is not in environments. Add it to environments or use one that is listed.`);
    else if (!b.environmentId) add(n, "empty_environmentId", "error", `Scene ${n} has no environmentId. Assign it one of the listed environments.`);

    // one primary action
    if (!blank(b.action)) {
      const multi = actionCount(b.action);
      if (multi.multi) add(n, "multi_action", "warning", `Scene ${n}'s action seems to hold more than one primary action (${multi.why}). Keep ONE observable action and move the rest to another scene.`);
      for (const r of RISKY_ACTIONS) {
        const m = r.re.exec(b.action);
        if (m && !negatedAt(b.action, m.index)) {
          const covered = (b.acceptance ?? []).some((a) => r.accept.every((re) => re.test(a)));
          if (!covered) add(n, r.code, "warning", `Scene ${n}'s action involves ${r.label}, which AI video often distorts. Choose a simpler action, or add an acceptance check that names this risk (for example that the face, hands and fingers stay intact and distinct).`);
        }
      }
    }

    // duration
    if (!Number.isFinite(b.seconds) || b.seconds <= 0) {
      add(n, "bad_duration", "error", `Scene ${n} has no valid length. Set seconds from the narration and the action.`);
    } else if (s && wordsIn(s.line) > 0 && s.speaker !== "none") {
      const needed = wordsIn(s.line) / WORDS_PER_SECOND + LANDING_PAUSE;
      if (b.seconds < needed - 0.05) {
        add(n, "duration_too_short", "error", `Scene ${n} runs ${b.seconds}s but its ${wordsIn(s.line)} spoken words need about ${needed.toFixed(1)}s at a natural pace. Lengthen the scene to at least ${Math.ceil(needed)}s.`);
      } else if (b.seconds > needed * DEAD_HOLD_FACTOR && b.seconds - needed > DEAD_HOLD_MIN_SURPLUS) {
        add(n, "duration_dead_hold", "warning", `Scene ${n} runs ${b.seconds}s for speech that needs about ${needed.toFixed(1)}s: the shot will hold with nothing new. Shorten it, or give the action enough to fill the time.`);
      }
    }

    // transition
    if (b.transition && b.transition.kind !== "cut" && blank(b.transition.rationale)) {
      add(n, "transition_no_rationale", "error", `Scene ${n} uses a ${b.transition.kind} but gives no reason. State why the story needs it, or use a plain cut.`);
    }

    if (!(b.acceptance ?? []).length) add(n, "no_acceptance", "warning", `Scene ${n} has no acceptance checks. List concrete things a reviewer can check on the clip.`);
    if (!(b.risks ?? []).length) add(n, "no_risks", "warning", `Scene ${n} lists no generation risks. Name what could go wrong in this shot.`);
  }

  // --- a clean video ends on its own last shot: there is no card after it
  const lastBrief = ordered[ordered.length - 1];
  if (clean && lastBrief) {
    const ending = `${lastBrief.action} ${lastBrief.exit?.condition ?? ""}`;
    const frozen = FROZEN_ENDING.exec(ending);
    if (frozen && !negatedAt(ending, frozen.index)) add(lastBrief.number, "ending_not_natural", "error", `Scene ${lastBrief.number} is the end of the film and ends on "${frozen[0]}". No end card follows a clean video: let the person finish the last words, then hold a relaxed, composed expression for a brief natural pause while the shot stays alive (or, for another style, close on a visual that completes the story).`);
  }

  // --- continuity between neighbours
  for (let i = 0; i < ordered.length; i += 1) {
    const b = ordered[i]!;
    if (b.entry?.mode !== "continue_previous") continue;
    const prev = ordered[i - 1];
    if (!prev) {
      add(b.number, "continue_first", "error", `Scene ${b.number} is the first scene but continues a previous one. Use a cut.`);
    } else if (prev.environmentId !== b.environmentId || (prev.characterId ?? null) !== (b.characterId ?? null)) {
      add(b.number, "continue_mismatch", "error", `Scene ${b.number} continues scene ${prev.number} but they do not share the same character and environment. Use a cut, or make both scenes the same character in the same place.`);
    }
  }

  // --- environment and setting repetition
  const groupOf: number[] = [];
  const groupFirst: Array<{ envId: string; setting: string }> = [];
  for (const b of ordered) {
    let g = groupFirst.findIndex((f) => f.envId === b.environmentId || (!blank(b.setting) && !blank(f.setting) && jaccard(f.setting, b.setting) >= SETTING_SIMILARITY_THRESHOLD));
    if (g < 0) {
      groupFirst.push({ envId: b.environmentId, setting: b.setting ?? "" });
      g = groupFirst.length - 1;
    }
    groupOf.push(g);
  }
  let run = 1;
  for (let i = 1; i < groupOf.length; i += 1) {
    run = groupOf[i] === groupOf[i - 1] ? run + 1 : 1;
    if (run === MAX_CONSECUTIVE_SAME_ENVIRONMENT + 1) {
      const start = ordered[i - run + 1]!.number;
      add(ordered[i]!.number, "environment_repeated", "error", `Scenes ${start} to ${ordered[i]!.number} all happen in the same place. More than ${MAX_CONSECUTIVE_SAME_ENVIRONMENT} in a row is a repeat. Move some of them to a different setting that fits the story, or cut away.`);
    }
  }
  if (ordered.length >= MIN_SCENES_FOR_SHARE_CHECK) {
    const counts = new Map<number, number>();
    for (const g of groupOf) counts.set(g, (counts.get(g) ?? 0) + 1);
    const top = Math.max(...counts.values());
    if (top / ordered.length > MAX_ENVIRONMENT_SHARE) {
      add(null, "environment_share", "error", `${top} of ${ordered.length} scenes share one setting (over ${Math.round(MAX_ENVIRONMENT_SHARE * 100)}%). Spread the story across more settings where it strengthens the message.`);
    }
  }
  for (let i = 1; i < ordered.length; i += 1) {
    const a = ordered[i - 1]!;
    const b = ordered[i]!;
    if (!blank(a.framing) && !blank(b.framing) && !blank(a.subject) && !blank(b.subject) && jaccard(a.framing, b.framing) >= SAME_SHOT_SIMILARITY_THRESHOLD && jaccard(a.subject, b.subject) >= SAME_SHOT_SIMILARITY_THRESHOLD) {
      add(b.number, "same_shot_repeated", "warning", `Scenes ${a.number} and ${b.number} use the same framing on the same subject. Change the shot size, angle or subject so the cut earns its place.`);
    }
  }

  // --- interchangeable information
  for (let i = 0; i < ordered.length; i += 1) {
    for (let j = i + 1; j < ordered.length; j += 1) {
      const a = ordered[i]!;
      const b = ordered[j]!;
      if (blank(a.informationAdded) || blank(b.informationAdded)) continue;
      if (jaccard(a.informationAdded, b.informationAdded) >= INFO_SIMILARITY_THRESHOLD) {
        add(b.number, "filler_duplicate_information", "error", `Scenes ${a.number} and ${b.number} add almost the same information or emotion ("${norm(a.informationAdded)}" and "${norm(b.informationAdded)}"). Each scene must add something the others do not; redesign or merge one of them.`);
      }
    }
  }

  // --- transitions overall
  const nonCut = ordered.slice(0, -1).filter((b) => b.transition && b.transition.kind !== "cut").length;
  if (ordered.length >= 4 && nonCut >= 3 && nonCut / Math.max(1, ordered.length - 1) > DECORATIVE_TRANSITION_SHARE) {
    add(null, "decorative_transitions", "warning", `${nonCut} of ${ordered.length - 1} transitions are dissolves or dips. Use plain cuts by default and keep a softer transition only where the story needs it.`);
  }

  // --- length
  const total = ordered.reduce((a, b) => a + (Number.isFinite(b.seconds) ? b.seconds : 0), 0);
  if (total > ctx.maxSeconds) add(null, "over_max_seconds", "error", `The scenes add up to ${total}s, over the ${ctx.maxSeconds}s maximum. Shorten scenes that hold longer than their speech needs.`);

  // --- environment and character bookkeeping
  const byNumber = new Map(ordered.map((b) => [b.number, b]));
  for (const e of plan.environments) {
    for (const num of e.sceneNumbers) {
      const b = byNumber.get(num);
      if (!b) add(null, "environment_scene_unknown", "error", `Environment "${e.id}" lists scene ${num}, which does not exist. Fix its sceneNumbers.`);
      else if (b.environmentId !== e.id) add(num, "environment_scene_mismatch", "error", `Environment "${e.id}" lists scene ${num}, but that scene's environmentId is "${b.environmentId}". Make the two agree.`);
    }
  }
  for (const b of ordered) {
    const e = plan.environments.find((x) => x.id === b.environmentId);
    if (e && !e.sceneNumbers.includes(b.number)) add(b.number, "environment_scene_unlisted", "error", `Scene ${b.number} uses environment "${e.id}" but the environment's sceneNumbers does not list it. Add ${b.number} to its sceneNumbers.`);
  }
  if (ctx.capabilities && !ctx.capabilities.referenceImages) {
    for (const c of plan.characters) {
      const uses = ordered.filter((b) => b.characterId === c.id);
      if (uses.length >= 2 && new Set(uses.map((b) => b.environmentId)).size >= 2) {
        add(null, "character_consistency_gap", "warning", `Character "${c.id}" appears in different environments but the video model cannot take reference images, so the face may drift. Describe the character identically in every scene and give those scenes strong consistency checks.`);
      }
    }
  }
  return issues;
}

// ------------------------------------------------------------------ normalisation

const slug = (id: string, fallback: string): string => {
  const s = String(id ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return s || fallback;
};

const asTransition = (k: string): SceneBrief["transition"]["kind"] => ((transitionKinds as readonly string[]).includes(k) ? (k as SceneBrief["transition"]["kind"]) : "cut");

const CLEAN_ACCEPTANCE = "No text, numbers, logos or graphics are visible anywhere in the frame";

function normaliseScene(raw: z.infer<typeof sceneBriefModelSchema>, scriptLine: string | undefined, mode?: "clean" | "branded"): SceneBrief {
  const t = (s: string) => String(s ?? "").trim();
  const narration = scriptLine !== undefined && norm(raw.narration ?? "") === norm(scriptLine) ? scriptLine : t(raw.narration);
  const scene = normaliseBranded(raw, narration);
  if (mode !== "clean") return scene;
  // Clean: whatever the model listed as a graphic becomes a note for the editor, and nothing about a graphic stays in a check the video model is shown.
  const notes: EditingNote[] = [...(scene.editingNotes ?? [])];
  const keyOf = (x: EditingNote) => `${x.kind}|${norm(x.text ?? "").toLowerCase()}|${x.assetId ?? ""}`;
  const known = new Set(notes.map(keyOf));
  const push = (note: EditingNote) => {
    if (known.has(keyOf(note))) return;
    known.add(keyOf(note));
    notes.push(note);
  };
  for (const o of scene.overlays) push({ kind: o.kind, ...(o.text ? { text: o.text } : {}), ...(o.claimId ? { claimId: o.claimId } : {}), ...(o.assetId ? { assetId: o.assetId } : {}) });
  for (const r of scene.requiredAssets) push({ kind: "image", assetId: r.assetId });
  const acceptance = footageOnly(scene.acceptance);
  return {
    ...scene,
    requiredAssets: [],
    overlays: [],
    screenTreatment: scene.screenTreatment === "composite_verified_asset" ? "footage_without_screen" : scene.screenTreatment,
    acceptance: [...acceptance, CLEAN_ACCEPTANCE],
    editingNotes: notes,
  };
}

function normaliseBranded(raw: z.infer<typeof sceneBriefModelSchema>, narration: string): SceneBrief {
  const t = (s: string) => String(s ?? "").trim();
  return {
    number: raw.number,
    purpose: t(raw.purpose),
    informationAdded: t(raw.informationAdded),
    narration,
    subject: t(raw.subject),
    setting: t(raw.setting),
    action: t(raw.action),
    framing: t(raw.framing),
    camera: t(raw.camera),
    lighting: t(raw.lighting),
    style: t(raw.style),
    characterId: raw.characterId && t(raw.characterId) ? slug(raw.characterId, "character") : null,
    environmentId: slug(raw.environmentId, ""),
    requiredAssets: raw.requiredAssets.map((r) => ({ assetId: t(r.assetId), use: r.use })),
    overlays: raw.overlays.map((o) => {
      const out: SceneBrief["overlays"][number] = { kind: o.kind };
      if (o.text && t(o.text)) out.text = t(o.text);
      if (o.claimId && t(o.claimId)) out.claimId = t(o.claimId);
      if (o.assetId && t(o.assetId)) out.assetId = t(o.assetId);
      return out;
    }),
    screenTreatment: raw.screenTreatment,
    seconds: Number(raw.seconds),
    durationBasis: t(raw.durationBasis),
    entry: { mode: raw.entry.mode, condition: t(raw.entry.condition) },
    exit: { condition: t(raw.exit.condition) },
    transition: { kind: asTransition(raw.transition.kind), rationale: t(raw.transition.rationale) },
    risks: raw.risks.map(t).filter(Boolean),
    acceptance: raw.acceptance.map(t).filter(Boolean),
    editingNotes: (raw.editingNotes ?? []).map((e) => {
      const out: EditingNote = { kind: e.kind };
      if (e.text && t(e.text)) out.text = t(e.text);
      if (e.claimId && t(e.claimId)) out.claimId = t(e.claimId);
      if (e.assetId && t(e.assetId)) out.assetId = t(e.assetId);
      if (e.position && t(e.position)) out.position = t(e.position);
      if (e.note && t(e.note)) out.note = t(e.note);
      return out;
    }),
  };
}

function basisOf(input: PlanInput): CreativePlan["basis"] {
  return {
    product: input.product,
    audience: input.audience,
    offer: input.offer,
    platform: input.platform,
    objective: input.objective,
    targetSeconds: input.targetSeconds,
    assetIds: input.assets.map((a) => a.id),
  };
}

/** Turn the model's output into a plan: basis from the input, ids made safe and consistent, narration kept verbatim. */
export function normalisePlan(raw: Omit<PlanModelOutput, "voice"> & { voice?: string }, input: PlanInput, now: string): Omit<CreativePlan, "validation"> {
  const lineOf = new Map(input.script.scenes.map((s) => [s.number, s.line]));
  const characters: PlanCharacter[] = raw.characters.map((c, i) => ({ id: slug(c.id, `character_${i + 1}`), description: c.description.trim(), role: c.role.trim() }));
  const environments: PlanEnvironment[] = raw.environments.map((e, i) => ({
    id: slug(e.id, `environment_${i + 1}`),
    description: e.description.trim(),
    sceneNumbers: [...new Set(e.sceneNumbers.filter((n) => Number.isInteger(n)))].sort((a, b) => a - b),
  }));
  const scenes = raw.scenes.map((s) => normaliseScene(s, lineOf.get(s.number), input.mode)).sort((a, b) => a.number - b.number);
  return {
    version: 1,
    createdAt: now,
    ...(input.mode ? { mode: input.mode } : {}),
    basis: basisOf(input),
    narrative: { approach: raw.narrative.approach.trim(), whyItFits: raw.narrative.whyItFits.trim(), arc: raw.narrative.arc.map((a) => a.trim()).filter(Boolean) },
    characters,
    environments,
    voice: raw.voice?.trim() || defaultVoice(input, characters, scenes),
    scenes,
  };
}

const ACCENTS: Record<string, string> = {
  "en-au": "an Australian English accent",
  "en-us": "an American English accent",
  "en-gb": "a British English accent",
  "en-nz": "a New Zealand English accent",
};

/** A voice for a plan that came without one: the speaking person's, described plainly, with the locale's accent. */
export function defaultVoice(input: Pick<PlanInput, "locale" | "script">, characters: PlanCharacter[], scenes: Array<Pick<SceneBrief, "number" | "characterId">>): string {
  const speaking = input.script.scenes.find((s) => s.speaker === "on_camera" && s.line.trim());
  const speakerId = speaking ? scenes.find((b) => b.number === speaking.number)?.characterId : null;
  const person = speakerId ? characters.find((c) => c.id === speakerId) : null;
  const accent = ACCENTS[input.locale.toLowerCase()] ?? "a natural accent";
  return `${person ? `The voice of ${person.description.split(/[.;]/)[0]!.trim()}: ` : ""}a warm, natural, conversational adult voice with ${accent}, mid pitch, an easy steady pace and even loudness.`;
}

function ctxFor(input: PlanInput): ValidateCtx {
  return {
    scriptScenes: input.script.scenes,
    assetIds: input.assets.map((a) => a.id),
    claimIds: input.claims.map((c) => c.id),
    maxSeconds: input.maxSeconds,
    capabilities: input.capabilities,
    claims: input.claims,
    mode: input.mode,
  };
}

// ------------------------------------------------------------------ generation

type Generate = (prompt: string) => Promise<unknown>;

const CLEAN_PLAN_SYSTEM =
  "You are a senior creative director and storyboard artist for short paid-social video ads. You design shots that an AI video model can generate cleanly as finished footage: real people, places and objects, natural movement, and nothing drawn on top. You make fresh, specific choices for each brief and never fall back on stock patterns.";

const PLAN_SYSTEM =
  "You are a senior creative director and storyboard artist for short paid-social video ads. You design shots that an AI video model can generate cleanly and that a renderer can complete with verified text, logos and screens. You make fresh, specific choices for each brief and never fall back on stock patterns.";

function defaultGenerate(schema: z.ZodType, temperature = 0.7, clean = false): Generate {
  return async (prompt) => {
    const candidates = modelCandidates();
    if (!candidates.length) throw new Error("No language model is configured to plan the video (set ANTHROPIC_API_KEY or OPENAI_API_KEY).");
    return withModelFallback(async (model) => (await generateObject({ model, schema, temperature, system: clean ? CLEAN_PLAN_SYSTEM : PLAN_SYSTEM, prompt })).object, candidates);
  };
}

function emptyPlan(input: PlanInput, now: string): Omit<CreativePlan, "validation"> {
  return { version: 1, createdAt: now, ...(input.mode ? { mode: input.mode } : {}), basis: basisOf(input), narrative: { approach: "", whyItFits: "", arc: [] }, characters: [], environments: [], voice: defaultVoice(input, [], []), scenes: [] };
}

/**
 * Design the plan: generate, normalise, validate, and send the issues back to the model up to
 * maxRepairs times. Always returns a plan; validation.ok is true only when there are no errors. A
 * failing plan is returned with its issues, never dropped.
 */
export async function planCreative(
  input: PlanInput,
  deps: { generate?: Generate; maxRepairs?: number; now?: () => string } = {},
): Promise<CreativePlan> {
  const generate = deps.generate ?? defaultGenerate(planModelSchema, 0.7, isClean(input));
  const maxRepairs = Math.max(0, deps.maxRepairs ?? 2);
  const now = deps.now ?? (() => new Date().toISOString());
  const ctx = ctxFor(input);

  let latest: { plan: Omit<CreativePlan, "validation">; issues: PlanIssue[] } | null = null;
  let pending: PlanIssue[] | undefined;
  let lastIssues: PlanIssue[] = [];

  for (let attempt = 0; attempt <= maxRepairs; attempt += 1) {
    let raw: unknown;
    try {
      raw = await generate(planPrompt(input, pending));
    } catch (error) {
      // No model configured at all is a setup problem to report, not something a fallback should hide.
      if (error instanceof Error && /No language model is configured/.test(error.message)) throw error;
      // A planning call that fails outright is one used attempt, not the end of the video.
      pending = [{ scene: null, code: "plan_call_failed", severity: "error", message: `The planning call failed (${error instanceof Error ? error.message : String(error)}). Return the complete plan.` }];
      lastIssues = pending;
      continue;
    }
    const parsed = planModelSchema.safeParse(withEditingNotes(raw));
    if (!parsed.success) {
      const message = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "plan"}: ${i.message}`).join("; ");
      pending = [{ scene: null, code: "schema_invalid", severity: "error", message: `The plan did not match the required structure (${message}). Return every field of every scene.` }];
      lastIssues = pending;
      continue;
    }
    // Mechanical problems (a scene too short for its words, ids that disagree, an empty field) are fixed here,
    // never sent back to the model: only creative problems use up a repair round.
    const plan = autoRepairPlan(normalisePlan(parsed.data, input, now()), input);
    const issues = validatePlan(plan, ctx);
    latest = { plan, issues };
    lastIssues = issues;
    pending = issues.length ? issues : undefined;
    if (!issues.some((i) => i.severity === "error")) break;
  }

  const checkedAt = now();
  // The model never produced a usable plan: build one from the script itself, so the video is still made.
  if (!latest) {
    const plan = autoRepairPlan(emptyPlan(input, checkedAt), input);
    const issues = settleIssues(validatePlan(plan, ctx), maxRepairs + 1);
    const note: PlanIssue = { scene: null, code: "plan_from_script", severity: "warning", message: `The planner did not return a usable plan (${lastIssues[0]?.message ?? "no reason given"}), so the shots follow the script's own visual directions.` };
    return { ...plan, validation: { ok: !issues.some((i) => i.severity === "error"), issues: [note, ...issues], checkedAt } };
  }
  const issues = settleIssues(latest.issues, maxRepairs + 1);
  return { ...latest.plan, validation: { ok: !issues.some((i) => i.severity === "error"), issues, checkedAt } };
}

/**
 * Creative preferences the planner is pushed on while it has repair rounds left. Once they are used up,
 * these never stop a video: the footage is still safe (text and graphics are kept out by the clip prompt
 * and caught by the clip inspection), so they are kept as warnings for the operator.
 */
const SOFT_PLAN_CODES = new Set([
  "environment_repeated",
  "environment_share",
  "filler_duplicate_information",
  "filler_typing",
  "filler_hologram",
  "filler_stock_office",
  "filler_glow_screen",
  "filler_ui_object",
  "text_in_footage",
  "graphic_in_footage",
  "ending_not_natural",
]);

/** After the last repair round: creative preferences become warnings; only problems that make the video impossible stay errors. */
export function settleIssues(issues: PlanIssue[], attempts: number): PlanIssue[] {
  return issues.map((i) =>
    i.severity === "error" && SOFT_PLAN_CODES.has(i.code) ? { ...i, severity: "warning" as const, message: `Kept after ${attempts} planning attempt${attempts === 1 ? "" : "s"}: ${i.message}` } : i,
  );
}

/** Seconds a spoken line needs at a natural pace, plus a short landing pause; 0 for no speech. */
export function secondsNeeded(line: string, speaker: string): number {
  const words = wordsIn(line);
  return words > 0 && speaker !== "none" ? words / WORDS_PER_SECOND + LANDING_PAUSE : 0;
}

/**
 * Fix everything in a plan that has one right answer, without asking the model again: every script scene
 * has exactly one brief, narration is the script's words, each scene is long enough to say its line, ids
 * point at things that exist, empty fields get a plain filmable default, and nothing a clean video cannot
 * show is listed. Creative choices are left as the planner made them.
 */
export function autoRepairPlan<T extends Omit<CreativePlan, "validation">>(plan: T, input: PlanInput): T {
  const clean = isClean(input);
  const assetIds = new Set(input.assets.map((a) => a.id));
  const claimIds = new Set(input.claims.map((c) => c.id));
  const characters = plan.characters;
  let environments = plan.environments.map((e) => ({ ...e }));
  if (!environments.length) environments = [{ id: "environment_1", description: input.script.setting || "the place the story happens", sceneNumbers: [] }];
  const envIds = new Set(environments.map((e) => e.id));
  const charIds = new Set(characters.map((c) => c.id));

  const byNumber = new Map<number, SceneBrief>();
  for (const b of plan.scenes) if (!byNumber.has(b.number)) byNumber.set(b.number, b);

  const recurring = characters[0]?.id ?? null;
  let previousEnv = environments[0]!.id;
  const scenes: SceneBrief[] = input.script.scenes.map((s) => {
    const found = byNumber.get(s.number);
    const fill = (value: string | undefined, fallback: string) => (blank(value) ? fallback : value!);
    const b: SceneBrief = found
      ? { ...found }
      : {
          number: s.number,
          purpose: `Carries the line of scene ${s.number}.`,
          informationAdded: s.line || s.visual,
          narration: s.line,
          subject: s.visual,
          setting: input.script.setting,
          action: s.visual,
          framing: "Medium shot at eye level",
          camera: s.camera || "Slow, steady push-in",
          lighting: "Soft natural light from a window",
          style: input.script.style,
          characterId: s.speaker === "on_camera" ? recurring : null,
          environmentId: previousEnv,
          requiredAssets: [],
          overlays: [],
          screenTreatment: "none",
          seconds: s.seconds,
          durationBasis: "From the script",
          entry: { mode: "cut", condition: "Cut in on the first word" },
          exit: { condition: "The line lands" },
          transition: { kind: "cut", rationale: "" },
          risks: [],
          acceptance: [],
          editingNotes: [],
        };
    b.narration = s.line;
    b.subject = fill(b.subject, b.characterId ? "the person" : "the scene");
    b.setting = fill(b.setting, input.script.setting || "the same place");
    b.action = fill(b.action, b.characterId ? "the person holds a natural, relaxed posture" : "the scene plays out naturally");
    b.framing = fill(b.framing, "Medium shot at eye level");
    b.camera = fill(b.camera, "Slow, steady push-in");
    b.lighting = fill(b.lighting, "Soft natural light from a window");
    b.style = fill(b.style, input.script.style);
    b.purpose = fill(b.purpose, `Carries the line of scene ${s.number}.`);
    b.informationAdded = fill(b.informationAdded, s.line || s.visual);
    if (b.characterId && !charIds.has(b.characterId)) b.characterId = null;
    if (!b.environmentId || !envIds.has(b.environmentId)) b.environmentId = previousEnv;
    previousEnv = b.environmentId;

    // Long enough to say the line, and never an invalid length.
    const needed = secondsNeeded(s.line, s.speaker);
    if (!Number.isFinite(b.seconds) || b.seconds <= 0) b.seconds = Math.max(2, Math.ceil(needed) || s.seconds || 3);
    if (b.seconds < needed - 0.05) {
      b.seconds = Math.ceil(needed);
      b.durationBasis = `${wordsIn(s.line)} spoken words at a natural pace (set by the app)`;
    }
    // No scene may outrun one clip of the video model (the check before Generate makes sure the words fit).
    if (input.maxSceneSeconds && b.seconds > input.maxSceneSeconds) b.seconds = Math.max(Math.ceil(needed), input.maxSceneSeconds);
    if (b.transition?.kind !== "cut" && blank(b.transition?.rationale)) b.transition = { kind: "cut", rationale: "" };

    if (clean) {
      b.requiredAssets = [];
      b.overlays = [];
      b.editingNotes = (b.editingNotes ?? []).filter((n) => (!n.assetId || assetIds.has(n.assetId)) && (!n.claimId || claimIds.has(n.claimId)) && !(n.kind === "stat" && !n.claimId));
    } else {
      b.requiredAssets = (b.requiredAssets ?? []).filter((r) => assetIds.has(r.assetId));
      b.overlays = (b.overlays ?? []).filter((o) => (!o.assetId || assetIds.has(o.assetId)) && (!o.claimId || claimIds.has(o.claimId)) && !(o.kind === "stat" && !o.claimId));
      if (b.screenTreatment === "composite_verified_asset" && !b.requiredAssets.length) b.screenTreatment = "footage_without_screen";
    }
    return b;
  });

  // A continuation needs a scene before it in the same place with the same person.
  for (let i = 0; i < scenes.length; i += 1) {
    const b = scenes[i]!;
    if (b.entry?.mode !== "continue_previous") continue;
    const prev = scenes[i - 1];
    if (!prev || prev.environmentId !== b.environmentId || (prev.characterId ?? null) !== (b.characterId ?? null)) b.entry = { mode: "cut", condition: b.entry.condition || "Cut in" };
  }

  // Over the maximum: take back time from scenes held longer than their words need, never below what they need.
  let total = scenes.reduce((t, b) => t + b.seconds, 0);
  for (const b of [...scenes].sort((x, y) => y.seconds - x.seconds)) {
    if (total <= input.maxSeconds) break;
    const s = input.script.scenes.find((x) => x.number === b.number);
    const floor = Math.max(2, Math.ceil(secondsNeeded(s?.line ?? "", s?.speaker ?? "none")));
    const cut = Math.min(b.seconds - floor, total - input.maxSeconds);
    if (cut > 0) {
      b.seconds -= cut;
      total -= cut;
    }
  }

  // Each environment lists exactly the scenes that use it.
  environments = environments.map((e) => ({ ...e, sceneNumbers: scenes.filter((b) => b.environmentId === e.id).map((b) => b.number) }));
  return { ...plan, environments, scenes };
}

// ------------------------------------------------------------------ lookups

export function sceneForShot(plan: CreativePlan, sceneNumber: number): SceneBrief | undefined {
  return plan.scenes.find((s) => s.number === sceneNumber);
}

/** A stable summary of the approach and each scene's setting, subject and framing: it changes when the plan does. */
export function planSignature(plan: CreativePlan): string {
  const clean = (s: string) => norm(s).toLowerCase();
  const scenes = [...plan.scenes].sort((a, b) => a.number - b.number).map((s) => `${s.number}:${clean(s.setting)}/${clean(s.subject)}/${clean(s.framing)}`);
  return [clean(plan.narrative.approach), ...scenes].join(" | ");
}

// ------------------------------------------------------------------ redesign one scene

const redesignModelSchema = z.object({
  scene: sceneBriefModelSchema,
  newEnvironment: z.object({ id: z.string(), description: z.string() }).nullable().describe("Only when the redesigned scene needs a place that is not in environments yet"),
});

/** The prompt that asks for one scene to be designed again, everything else fixed. */
export function redesignPrompt(input: PlanInput, plan: CreativePlan, sceneNumber: number, failures: string[]): string {
  const current = sceneForShot(plan, sceneNumber);
  const neighbours = plan.scenes
    .filter((s) => s.number !== sceneNumber)
    .map((s) => `- Scene ${s.number}: ${s.setting}; subject ${s.subject}; action ${s.action}; framing ${s.framing}; character ${s.characterId ?? "none"}; environment ${s.environmentId}`)
    .join("\n");
  return [
    planPrompt(input),
    `REDESIGN ONE SCENE\nThe plan above exists and only scene ${sceneNumber} must be designed again. Its footage failed review for these reasons:\n${failures.map((f) => `- ${f}`).join("\n") || "- (none given)"}`,
    `The scene as it is now (this is what failed; do not repeat it):\n${JSON.stringify(current ?? {}, null, 2)}`,
    `The other scenes, which stay as they are:\n${neighbours || "(none)"}`,
    `Environments available: ${plan.environments.map((e) => `${e.id} (${e.description})`).join("; ") || "(none)"}. Characters available: ${plan.characters.map((c) => `${c.id} (${c.description})`).join("; ") || "(none)"}.`,
    `Design scene ${sceneNumber} again with a different framing, action or method that avoids what failed (for example, if the failure involved hands or the face, use an action without hand interaction or an unobstructed face). Keep its narration word for word and its length of ${current?.seconds ?? "the same"} seconds. Keep it consistent with the neighbouring scenes' character, lighting and art direction, and obey every hard rule. Return only this scene in "scene"; set "newEnvironment" only if it needs a place not listed.`,
  ].join("\n\n");
}

/**
 * Redesign one scene after its footage failed: the model proposes a different shot, narration and
 * seconds are kept, the plan is validated again and returned.
 */
export async function redesignScene(
  input: PlanInput,
  plan: CreativePlan,
  sceneNumber: number,
  failures: string[],
  deps: { generate?: Generate; now?: () => string } = {},
): Promise<CreativePlan> {
  const current = sceneForShot(plan, sceneNumber);
  if (!current) throw new Error(`Scene ${sceneNumber} is not in the plan.`);
  const generate = deps.generate ?? defaultGenerate(redesignModelSchema, 0.8, isClean(input));
  const now = deps.now ?? (() => new Date().toISOString());
  const raw = await generate(redesignPrompt(input, plan, sceneNumber, failures));
  const parsed = redesignModelSchema.safeParse(withEditingNotes(raw));
  const checkedAt = now();
  if (!parsed.success) {
    const message = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "scene"}: ${i.message}`).join("; ");
    const issue: PlanIssue = { scene: sceneNumber, code: "schema_invalid", severity: "error", message: `The redesigned scene did not match the required structure (${message}).` };
    return { ...plan, validation: { ok: false, issues: [...plan.validation.issues.filter((i) => i.code !== "schema_invalid"), issue], checkedAt } };
  }

  const redesigned = normaliseScene({ ...parsed.data.scene, number: sceneNumber }, current.narration, input.mode);
  // The words and the length are fixed by the script: keep them whatever the model returned. A redesign of the picture does not lose the editor's notes.
  const scene: SceneBrief = { ...redesigned, narration: current.narration, seconds: current.seconds, editingNotes: redesigned.editingNotes?.length ? redesigned.editingNotes : current.editingNotes };

  let environments = plan.environments.map((e) => ({ ...e, sceneNumbers: e.sceneNumbers.filter((n) => n !== sceneNumber) }));
  const ne = parsed.data.newEnvironment;
  if (ne) {
    const id = slug(ne.id, `environment_${environments.length + 1}`);
    if (!environments.some((e) => e.id === id)) environments.push({ id, description: ne.description.trim(), sceneNumbers: [] });
  }
  environments = environments.map((e) => (e.id === scene.environmentId ? { ...e, sceneNumbers: [...e.sceneNumbers, sceneNumber].sort((a, b) => a - b) } : e)).filter((e) => e.sceneNumbers.length > 0 || e.id === scene.environmentId);

  const next: Omit<CreativePlan, "validation"> = {
    version: plan.version,
    createdAt: plan.createdAt,
    ...(plan.mode ? { mode: plan.mode } : {}),
    basis: plan.basis,
    narrative: plan.narrative,
    characters: plan.characters,
    environments,
    scenes: plan.scenes.map((s) => (s.number === sceneNumber ? scene : s)),
  };
  const issues = validatePlan(next, ctxFor(input));
  return { ...next, validation: { ok: !issues.some((i) => i.severity === "error"), issues, checkedAt } };
}
