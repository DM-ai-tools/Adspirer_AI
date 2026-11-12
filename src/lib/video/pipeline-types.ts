/**
 * Shared, client-safe types for the verified video pipeline: the brand manifest, claims, the
 * pronunciation lexicon, the creative plan, and the quality-gate reports. Types and tiny helpers
 * only, so the editor, the server and the tests all agree on one shape. Everything here is stored
 * inside the existing jsonb columns of video_projects (no migration).
 */

// ------------------------------------------------------------------ provenance

export type ProvenanceSource =
  | "page_jsonld" // schema.org structured data on the page
  | "page_meta" // og:site_name, application-name, apple-mobile-web-app-title
  | "page_header" // header / nav of the page (logo alt text, brand link)
  | "page_footer" // footer (copyright line, footer logo)
  | "page_text" // body copy
  | "page_css" // a stylesheet rule (logo background image, brand variables)
  | "scrape" // the Firecrawl / OpenAI brand scrape
  | "client_record" // what the operator saved on the client in the app
  | "operator" // typed or chosen by the operator for this video
  | "upload" // an uploaded file
  | "image_reading" // read from an uploaded image by the vision model
  | "derived_domain" // derived from the site's domain name (weak)
  | "internal"; // an internal label: never customer-facing

export type Confidence = "high" | "medium" | "low";

export type Provenance = {
  source: ProvenanceSource;
  /** Human readable: where exactly (e.g. "JSON-LD Organization.name", "<header> img alt"). */
  detail: string;
  url?: string;
  confidence: Confidence;
};

export type Sourced<T> = { value: T; provenance: Provenance[] };

// ------------------------------------------------------------------ brand manifest

export type BrandIssueCode =
  | "name_missing"
  | "name_conflict"
  | "name_internal"
  | "name_unverified"
  | "logo_missing"
  | "logo_unverified"
  | "logo_low_resolution"
  | "logo_illegible"
  | "logo_conflict"
  | "colors_missing"
  | "offer_missing"
  | "cta_missing"
  | "claim_unsourced";

export type BrandIssue = {
  code: BrandIssueCode;
  /** "blocking" stops video generation / delivery until resolved; "warning" is shown only. */
  severity: "blocking" | "warning";
  field: "name" | "logo" | "colors" | "offer" | "cta" | "claims" | "sourceUrl";
  message: string;
  /** What the operator can do about it, in plain words. */
  resolution: string;
};

export type LogoRole = "company" | "partner" | "client" | "badge" | "icon" | "decorative" | "unknown";

export type LogoCandidate = {
  /** Absolute http(s) URL or a data: URI. */
  url: string;
  role: LogoRole;
  /** Higher is more likely to be the company's own logo. */
  score: number;
  provenance: Provenance;
  /** Why it was rejected as the company logo, if it was. */
  rejectedReason?: string;
};

export type LogoVerification = {
  ok: boolean;
  format: "png" | "jpeg" | "webp" | "svg" | "gif" | "unknown";
  width: number;
  height: number;
  hasAlpha: boolean;
  /** Share of pixels that are transparent (0-1). */
  transparentShare: number;
  /** Mean luminance (0-255) of the visible (non-transparent) pixels. */
  luminance: number;
  /** Whether the visible pixels read against a typical light and dark plate. */
  legibleOnLight: boolean;
  legibleOnDark: boolean;
  problems: string[];
};

export type LogoAsset = {
  /** The original, untouched file saved in storage. */
  storageKey: string;
  mime: string;
  /** Where it came from: the page URL of the image, or the file name for an upload. */
  sourceUrl: string | null;
  origin: "page" | "upload" | "client";
  verification: LogoVerification;
  provenance: Provenance[];
};

export type ClaimKind = "number" | "statement" | "offer" | "credential";

/** What an uploaded file is for. A file that carries figures is the operator's approved proof; anything else supports the brief. */
export type AssetPurpose = "approved_proof_screenshot" | "supporting_image";

/** What a figure measures. Kept apart because they are not interchangeable: a platform's tracked conversion value is not audited sales revenue. */
export type StatMetric = "ad_spend" | "conversion_value" | "sales_revenue" | "cost_per_conversion" | "conversion_value_per_cost" | "other";

/** Something to settle before a figure from an image is used. */
export type EvidenceCaution = {
  code: "label_differs" | "time_claim_unsupported" | "currency_unstated";
  /** The figure it concerns, when it concerns one. */
  figure?: string;
  message: string;
};

export type ApprovedClaim = {
  id: string;
  /** The claim as it may be shown or spoken, e.g. "$12M+ in e-commerce sales generated". */
  text: string;
  kind: ClaimKind;
  /** The figure itself when the claim is numeric, exactly as written at the source ("$12M+", "255%"). */
  figure?: string;
  /** The words at the source that support it (verbatim quote or what the image printed). */
  evidence: string;
  provenance: Provenance;
  /** An uploaded image id this claim was read from, when it came from one. */
  assetId?: string;
  /** What the figure measures according to the source's own label (not a note added on top of it). */
  metric?: StatMetric;
  /** The period the source says the figure covers, as printed. */
  dateRange?: string | null;
};

export type BrandManifest = {
  version: 1;
  createdAt: string;
  /** Isolation: a manifest and its files belong to exactly one client and one video project. */
  clientId: string;
  projectId: string | null;
  sourceUrl: Sourced<string | null>;
  /** The canonical PUBLIC company name: the only name ever shown to viewers. */
  name: Sourced<string | null>;
  nameCandidates: Array<{ value: string; provenance: Provenance; rejectedReason?: string }>;
  /** Internal campaign names, project titles, file names and page titles: kept apart, never customer-facing. */
  internalLabels: Array<{ value: string; provenance: Provenance }>;
  logo: LogoAsset | null;
  logoCandidates: LogoCandidate[];
  colors: Sourced<string[]>;
  offer: Sourced<string | null>;
  /** The customer-facing call to action, e.g. { label: "Book a free audit", url }. */
  cta: Sourced<{ label: string; url?: string } | null>;
  audience: Sourced<string | null>;
  claims: ApprovedClaim[];
  /** The operator explicitly allowed a text-only treatment (the verified name, no logo). */
  allowTextOnlyBrand: boolean;
  conflicts: Array<{ field: string; values: Array<{ value: string; provenance: Provenance }>; chosen: string | null; reason: string }>;
  issues: BrandIssue[];
};

/** True when the manifest has nothing blocking and can be used to make a video. */
export function manifestReady(m: Pick<BrandManifest, "issues"> | null | undefined): boolean {
  return Boolean(m) && !m!.issues.some((i) => i.severity === "blocking");
}

// ------------------------------------------------------------------ pronunciation and speech

export type PronunciationKind = "brand" | "acronym" | "initialism" | "number" | "currency" | "percent" | "date" | "technical" | "abbreviation";

/** How a term is said: letter by letter, as a word, expanded into other words, or left as written. */
export type PronunciationDecision = "spell" | "word" | "expand" | "verbatim";

export type PronunciationEntry = {
  /** The term exactly as written in the display text (case-sensitive), e.g. "ROAS", "$12M+", "GA4". */
  term: string;
  kind: PronunciationKind;
  decision: PronunciationDecision;
  /** What is put in the speech text, e.g. "roh-ass", "G A four", "over twelve million dollars". */
  spoken: string;
  reason: string;
  confidence: Confidence;
  /** True when the choice is a guess that audio review should confirm. */
  needsReview: boolean;
  source: "operator" | "brand_guidance" | "rule" | "model";
};

export type PronunciationLexicon = {
  locale: string;
  entries: PronunciationEntry[];
  /** What the voice provider supports, so no unsupported markup is ever sent. */
  provider: { ssml: boolean; phonemes: boolean; dictionary: boolean; note: string };
  createdAt: string;
};

/** One run of display text and what is said for it. Concatenating `display` gives the display line. */
export type SpeechSegment = { display: string; spoken: string; term?: string };

export type SpeechLine = {
  sceneNumber: number;
  /** What the subtitles show: the correct written terms. */
  display: string;
  /** What is sent to the voice: abbreviations and numbers handled intentionally. */
  spoken: string;
  segments: SpeechSegment[];
  /** Terms whose pronunciation is a guess, for audio review. */
  uncertain: string[];
};

// ------------------------------------------------------------------ creative plan

export type SceneTransition = { kind: "cut" | "match_cut" | "dissolve" | "dip_to_colour"; rationale: string };

/**
 * A suggestion for the person finishing a clean video by hand: a piece of text or a file they may
 * add. Kept apart from everything the video model is told, and never rendered by this application.
 */
export type EditingNote = {
  kind: "stat" | "keyword" | "cta" | "url" | "logo" | "image" | "end_card";
  /** The exact wording suggested, when it is text. */
  text?: string;
  claimId?: string;
  assetId?: string;
  /** Where it could sit, in plain words ("lower third, centred"). */
  position?: string;
  /** Why it is worth adding, or what to watch for. */
  note?: string;
};

export type SceneBrief = {
  /** The script scene this brief belongs to. */
  number: number;
  /** Optional suggestions for manual graphics. Never part of the footage request. */
  editingNotes?: EditingNote[];
  purpose: string;
  /** What this scene adds that no other scene does: information or emotion. */
  informationAdded: string;
  /** The words spoken (display text), copied from the script. */
  narration: string;
  subject: string;
  setting: string;
  /** One clear, observable primary action. */
  action: string;
  framing: string;
  camera: string;
  lighting: string;
  style: string;
  /** Id of the character this scene uses (see CreativePlan.characters) or null. */
  characterId: string | null;
  /** Id of the environment (see CreativePlan.environments). */
  environmentId: string;
  /** Uploaded images this scene needs and how each is used (composited by the renderer, never drawn by the model). */
  requiredAssets: Array<{ assetId: string; use: "overlay_full" | "overlay_inset" }>;
  /** Everything drawn on top by the renderer: exact text and brand marks. */
  overlays: Array<{ kind: "stat" | "keyword" | "cta" | "url" | "logo" | "image"; text?: string; claimId?: string; assetId?: string }>;
  /** What the footage shows when the scene is about a screen or a result: the model never draws readable UI. */
  screenTreatment: "none" | "composite_verified_asset" | "footage_without_screen";
  seconds: number;
  /** How the length was derived (narration length, action length, graphic reading time). */
  durationBasis: string;
  entry: { mode: "cut" | "continue_previous"; condition: string };
  exit: { condition: string };
  transition: SceneTransition;
  risks: string[];
  /** Concrete things a reviewer can check on the clip. */
  acceptance: string[];
};

export type PlanCharacter = { id: string; description: string; role: string };
export type PlanEnvironment = { id: string; description: string; sceneNumbers: number[] };

export type PlanIssue = { scene: number | null; code: string; severity: "error" | "warning"; message: string };

export type CreativePlan = {
  version: 1;
  createdAt: string;
  /** "clean": the footage is the whole picture and nothing is composited. Absent on plans made before clean video existed. */
  mode?: "clean" | "branded";
  /** What the plan was derived from, so a change in inputs visibly changes the plan. */
  basis: { product: string; audience: string; offer: string; platform: string; objective: string; targetSeconds: number; assetIds: string[] };
  narrative: { approach: string; whyItFits: string; arc: string[] };
  characters: PlanCharacter[];
  environments: PlanEnvironment[];
  /** The one voice for every spoken line, repeated word for word in every clip. Absent on plans made before it existed. */
  voice?: string;
  scenes: SceneBrief[];
  validation: { ok: boolean; issues: PlanIssue[]; checkedAt: string };
};

// ------------------------------------------------------------------ quality gates

export type QaSeverity = "critical" | "major" | "minor";

export type QaCategory = "face" | "hands" | "anatomy" | "temporal" | "text" | "branding" | "relevance" | "speech" | "lipsync" | "audio" | "technical" | "composition" | "claims" | "subtitles";

export type QaFinding = {
  code: string;
  severity: QaSeverity;
  category: QaCategory;
  message: string;
  /** What was seen or measured. */
  evidence: string;
  atSeconds?: number;
  /** A targeted correction to add to the next attempt's prompt, or to change in the plan. */
  correction: string;
  source: "ffmpeg" | "vision" | "asr" | "rule";
};

export type QaCheckResult = { name: string; ok: boolean; detail: string; severity?: QaSeverity };

export type QaVerdict = "pass" | "retry" | "redesign" | "unresolved";

export type QaReport = {
  subject: { kind: "clip"; clip: number } | { kind: "final" };
  attempt: number;
  checkedAt: string;
  verdict: QaVerdict;
  findings: QaFinding[];
  checks: QaCheckResult[];
  framesInspected: number;
  /** What could not be checked here (no vision model configured, no transcription key, ...). */
  limitations: string[];
};

export type ClipAttemptRecord = {
  attempt: number;
  taskId: string | null;
  prompt: string | null;
  /** The correction lines added to this attempt's prompt because of the previous attempt's findings. */
  corrections: string[];
  report: QaReport | null;
  usd: number | null;
  startedAt: string;
};

/** True when any finding is critical: a critical finding blocks delivery. */
export function hasCritical(findings: Array<Pick<QaFinding, "severity">>): boolean {
  return findings.some((f) => f.severity === "critical");
}

// ------------------------------------------------------------------ capabilities

export type ProviderCapabilities = {
  /** Reference-image conditioning for a recurring character. */
  referenceImages: boolean;
  firstLastFrame: boolean;
  /** Voice is generated by the video model itself; no separate speech provider. */
  nativeAudio: boolean;
  ssml: boolean;
  phonemeDictionary: boolean;
  /** Lip-sync comes from the video model's own audio-video generation; it is checked, not controlled. */
  lipSync: "native_model_audio";
  transcription: boolean;
  visionReview: boolean;
  perspectiveScreenTracking: boolean;
  gaps: string[];
};
