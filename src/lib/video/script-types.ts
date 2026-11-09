/**
 * Shared, client-safe types for the script workflow: the creative brief (what the page really says,
 * with sources), the angle plan (how the three versions differ), and what a written version carries
 * beyond its scenes. Stored inside existing jsonb columns (no migration).
 */

// ------------------------------------------------------------------ sources and facts

export type SourceKind = "page" | "operator" | "image" | "manifest" | "client_record";

/** A piece of source material a fact can be traced to. */
export type SourceRef = {
  id: string;
  kind: SourceKind;
  /** Human readable: "Landing page", "Your offer details", "Image: results.png". */
  label: string;
  /** The words at the source that support the fact, verbatim. */
  quote: string;
  url?: string;
};

export type FactCategory = "offer" | "audience" | "problem" | "mechanism" | "proof" | "price" | "condition" | "credential" | "feature" | "conversion" | "voice" | "other";

/** Something the sources directly say. Every fact has a quote that was found in a source. */
export type BriefFact = {
  id: string;
  /** The fact in clear customer language, without changing what is claimed. */
  text: string;
  category: FactCategory;
  source: SourceRef;
  /** For a result or testimonial: whose, when, and under what conditions, so it is never stretched into a universal promise. */
  scope?: string;
};

/** Something the writer infers from the facts (never shown to viewers as fact). */
export type BriefInference = {
  id: string;
  text: string;
  kind: "situation" | "consequence" | "objection" | "desired_outcome" | "vocabulary" | "mechanism" | "other";
  /** The facts it is based on. */
  basis: string[];
};

export type BriefDefault = { field: "audience" | "platform" | "tone" | "goal" | "speechRate"; value: string; why: string };

export type BriefGap = {
  field: string;
  /** What is missing and why it matters. */
  why: string;
  /** Without this the scripts cannot be written without inventing things. */
  essential: boolean;
  /** The one question to ask the operator. */
  ask: string;
};

export type CreativeBrief = {
  version: 1;
  createdAt: string;
  /** Verified public company name (from the brand manifest), or null. */
  company: { name: string | null; source: string };
  offer: { name: string; description: string; factIds: string[] };
  /** The real next step the page asks for, e.g. "Book a free 30 minute audit" with where it goes. */
  conversion: { action: string; target: string | null; benefit: string | null; factIds: string[] } | null;
  audience: { primary: string; situation: string; factIds: string[]; inferred: boolean };
  /** How the offer works, in plain words, when the sources explain it. */
  mechanism: { plain: string; distinctive: boolean; factIds: string[] } | null;
  facts: BriefFact[];
  inferences: BriefInference[];
  /** Facts dropped because their quote could not be found in any source. */
  rejectedFacts: Array<{ text: string; reason: string }>;
  voice: { tone: string; vocabulary: string[]; avoid: string[] };
  defaults: BriefDefault[];
  gaps: BriefGap[];
  /** "rich": plenty to write from. "thin": usable but generic. "insufficient": would force inventing. */
  sourceQuality: "rich" | "thin" | "insufficient";
  limitation: string | null;
  /** Instruction-like text found in the page and treated as data. */
  injectionFlags: string[];
};

// ------------------------------------------------------------------ angles

export type AnglePlan = {
  id: string;
  /** A descriptive name from the actual idea, e.g. "The cost nobody invoices", not a category label. */
  name: string;
  /** The particular customer situation this version speaks to. */
  situation: string;
  /** The core tension, desire or objection. */
  tension: string;
  centralMessage: string;
  /** What the opening is about (not the words). */
  hookPremise: string;
  /** The mechanism or proof that carries the message. */
  support: { text: string; factIds: string[] };
  tone: string;
  /** Why the viewer should act now. */
  reasonToAct: string;
  /** One sentence: what makes this version different from the others. */
  whyDifferent: string;
};

export type AngleIssue = { angle: string | null; code: string; severity: "error" | "warning"; message: string };

// ------------------------------------------------------------------ what a written version carries

export type HookCandidate = { line: string; why: string; chosen: boolean };

export type ScriptSpeech = {
  words: number;
  /** Estimated from words and pauses at `wordsPerSecond`. */
  estimatedSeconds: number;
  wordsPerSecond: number;
  /** The requested length this was written for. */
  requestedSeconds: number;
  budgetWords: { min: number; target: number; max: number };
  fit: "fits" | "long" | "short";
  /** Set once real audio exists: the spoken length measured from the generated video. */
  measuredSeconds?: number | null;
};

export type ScriptCta = {
  /** What is said. */
  spoken: string;
  /** The button label from Meta's list. */
  label: string;
  /** Where it leads, as the landing page says. */
  target: string | null;
  /** What the viewer gets by taking the step, when useful. */
  benefit: string | null;
};

export type ScriptSource = { claim: string; factId: string; source: SourceRef };

export type EditorialIssue = {
  scene: number | null;
  severity: "hard" | "major" | "minor";
  area: "opening" | "voice" | "idea" | "development" | "offer" | "claims" | "duration" | "visuals" | "cta" | "overlap" | "experience";
  problem: string;
  fix: string;
};

export type EditorialReport = {
  /** Review rounds that rewrote something (bounded). */
  passes: number;
  fixes: Array<{ target: string; reason: string }>;
  /** Problems still open after the bounded passes. */
  open: EditorialIssue[];
  /** Hard failures that remain: unsupported claims, wrong brand info, misleading duration, fabricated testimonials, duplicate angles. */
  hardFailures: EditorialIssue[];
  /** Where the source material limits what could be done, in plain words. */
  limitation: string | null;
  /** Rated by a model: an editorial signal, never a prediction of performance. */
  signals: { opening: number | null; naturalness: number | null; specificity: number | null };
  checkedAt: string;
};

export type ScriptExtras = {
  angleDetail?: AnglePlan;
  differentiator?: string;
  hook?: { line: string; candidates: HookCandidate[]; payoff: string };
  /** One short paragraph for the whole video: what is filmed and shown, in service of the message. */
  visualDirection?: string;
  /** Words or figures shown on screen. */
  onScreen?: string[];
  cta?: ScriptCta;
  speech?: ScriptSpeech;
  sources?: ScriptSource[];
  /** A dramatisation (a presenter acting out a situation) is labelled so it is never read as a testimonial. */
  dramatisation?: boolean;
  editorial?: EditorialReport;
};

export const hasHardFailure = (issues: Array<Pick<EditorialIssue, "severity">>) => issues.some((i) => i.severity === "hard");
