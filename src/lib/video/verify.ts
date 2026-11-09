import { generateObject } from "ai";
import { z } from "zod";
import { pickModel } from "@/lib/creatives/concept-writer";
import { logger } from "@/lib/observability/logger";
import { checkScript, type VideoBrief, type VideoScene, type VideoScript } from "@/lib/video/script";
import { regenerateScene, rewriteAdCopy, type RewriteContext } from "@/lib/video/rewrite";
import { SYSTEM } from "@/lib/video/voice";
import { retime } from "@/lib/video/timing";
import type { ApprovedClaim } from "@/lib/video/pipeline-types";

export type Issue = {
  /** The scene it is about, or null for the ad copy or the script as a whole. */
  scene: number | null;
  severity: "low" | "medium" | "high";
  area: string;
  problem: string;
  fix: string;
};

export type Verification = {
  /** The reviewer's overall score out of 10, or null when the AI review could not run. */
  score: number | null;
  verdict: "passed" | "fixed" | "needs_review";
  summary: string;
  /** What the system rewrote on its own, and why. */
  fixes: Array<{ target: string; reason: string }>;
  /** What is still open, for the operator to look at. */
  issues: Issue[];
  checkedAt: string;
};

const reviewSchema = z.object({
  score: z.number().min(1).max(10).describe("Overall quality as a Meta video ad, 1-10. Be strict: 8 means ready to run."),
  summary: z.string().describe("Two sentences: the strongest part and the weakest part"),
  issues: z
    .array(
      z.object({
        scene: z.number().int().nullable().describe("Scene number, or null for the ad copy or the script as a whole"),
        severity: z.enum(["low", "medium", "high"]),
        area: z.enum(["hook", "claims", "tone", "flow", "compliance", "pace", "cta", "continuity", "copy", "visuals"]),
        problem: z.string(),
        fix: z.string().describe("What the rewrite should do, concretely"),
      }),
    )
    .max(14),
});

const REVIEW_RULES = [
  "You are a strict reviewer of Meta video ad scripts. Review the script below against the facts and report only real problems. Check:",
  "- hook: do the first 2-3 seconds earn attention with a visual and a line that fit the framework? Is the hook specific, not generic?",
  "- claims: is every number, result, award, customer and claim supported by the facts? An invented or exaggerated claim is HIGH severity.",
  "- tone: does every spoken line sound like a real person talking (contractions, short sentences, plain words), or like an ad, AI or a teleprompter?",
  "- flow: does each scene follow from the last, with a clear problem, turn and payoff, and does the story fit its framework and angle?",
  "- continuity: is the presenter, setting and look consistent scene to scene? Does a scene contradict another?",
  "- compliance: Meta ad policy problems: personal-attribute call-outs (health, finances, age), before/after or income claims, 'guaranteed' or superlatives without proof, misleading urgency. HIGH severity.",
  "- visuals: is each scene a filmable shot of a person, object or place that an AI video model can render well? A shot that is a screen, dashboard, chart, document, sign or anything with readable text is HIGH severity (the model draws it as garbled nonsense); the real stat or screenshot is added on top afterwards. Flag generic stock-looking visuals too and suggest a specific, real, slightly unexpected one.",
  "- pace and length: can each spoken line be said in its scene's seconds at a natural pace?",
  "- cta: is there one clear next step, and does the ad copy match the video?",
  "- copy: the primary text has a standalone hook in its first line, a real body, and the next step.",
  "Give a fix that says concretely what to change. Do not invent problems; an empty list is a good result.",
].join("\n");

function serialise(script: VideoScript): string {
  return [
    `Angle: ${script.angle.name}, targets ${script.pain}. Framework: ${script.framework.name}. Style: ${script.style}.`,
    script.character ? `Presenter: ${script.character}` : "No presenter.",
    `Setting: ${script.setting}`,
    ...script.scenes.map(
      (s) => `Scene ${s.number} (${s.seconds}s, ${s.speaker}): sees: ${s.visual} | says: "${s.line}"${s.keywords.length ? ` | highlight: ${s.keywords.join(", ")}` : ""}${s.stat ? ` | stat: ${s.stat}` : ""}`,
    ),
    `Ad copy primary text:\n${script.adCopy.primaryText}`,
    `Headline: ${script.adCopy.headline} | CTA: ${script.adCopy.cta}`,
  ].join("\n");
}

/** The AI review. Returns null when it cannot run, so the deterministic checks still protect the script. */
export async function reviewScript(script: VideoScript, facts: string): Promise<z.infer<typeof reviewSchema> | null> {
  const model = pickModel();
  if (!model) return null;
  try {
    const { object } = await generateObject({ model, schema: reviewSchema, temperature: 0, system: SYSTEM, prompt: `${REVIEW_RULES}\n\nFACTS\n${facts}\n\nSCRIPT\n${serialise(script)}` });
    return object;
  } catch (error) {
    logger.warn("Script review failed", { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/** The rule-based warnings as issues, so they sit in one list with the reviewer's. */
export function warningsToIssues(warnings: string[]): Issue[] {
  return warnings.map((w) => {
    const scene = w.match(/^Scene (\d+)/)?.[1];
    const high = /not in your page or inputs|no recorded source|not uploaded|over the \d+s limit|garbled text/.test(w);
    return {
      scene: scene ? Number(scene) : null,
      severity: high ? "high" : "medium",
      area: /garbled text/.test(w) ? "visuals" : /not in your page|no recorded source/.test(w) ? "claims" : /contraction|sounds|sentence|dash/.test(w) ? "tone" : /too fast|Runs/.test(w) ? "pace" : /ad copy|first line/.test(w) ? "copy" : "flow",
      problem: w,
      fix: "Rewrite this to fix the problem.",
    };
  });
}

export type VerifyContext = {
  brief: VideoBrief;
  facts: string;
  corpus: string;
  assetIds: string[];
  target: number;
  /** Approved, sourced claims. When given, every figure is checked against them by value. */
  claims?: ApprovedClaim[];
};

function merge(rule: Issue[], review: Issue[]): Issue[] {
  const seen = new Set<string>();
  const out: Issue[] = [];
  for (const issue of [...rule, ...review]) {
    const key = `${issue.scene}|${issue.area}|${issue.problem.slice(0, 40).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
  }
  return out.sort((a, b) => ({ high: 0, medium: 1, low: 2 })[a.severity] - ({ high: 0, medium: 1, low: 2 })[b.severity]);
}

/** A review without fixing anything: the rule checks and the AI review in one list. */
export async function checkOnly(script: VideoScript, ctx: VerifyContext): Promise<Verification> {
  const warnings = checkScript(script, { corpus: ctx.corpus, assetIds: ctx.assetIds, target: ctx.target, claims: ctx.claims });
  const review = await reviewScript(script, ctx.facts);
  const issues = merge(
    warningsToIssues(warnings),
    (review?.issues ?? []).map((i) => ({ scene: i.scene, severity: i.severity, area: i.area, problem: i.problem, fix: i.fix })),
  );
  const open = issues.filter((i) => i.severity !== "low");
  return {
    score: review?.score ?? null,
    verdict: open.length ? "needs_review" : "passed",
    summary: review?.summary ?? (review ? "" : "The AI review could not run, so only the rule checks were applied."),
    fixes: [],
    issues,
    checkedAt: new Date().toISOString(),
  };
}

/** At most this many scenes are rewritten per script by the verifier, worst first. */
const MAX_AUTO_FIXES = 3;

/**
 * Check a script, rewrite its weakest flagged scenes (and the ad copy if it is flagged), and check
 * again. Runs once, so cost and time stay bounded; whatever is still open is left for the operator.
 */
export async function verifyAndFix(script: VideoScript, ctx: VerifyContext): Promise<VideoScript> {
  const first = await checkOnly(script, ctx);
  const rewriteCtx: RewriteContext = { facts: ctx.facts, assetIds: ctx.assetIds, locale: ctx.brief.locale };
  const fixes: Verification["fixes"] = [];

  // Worst scenes first: any high issue, then the most issues.
  const bySceneAll = new Map<number, Issue[]>();
  for (const i of first.issues) if (i.scene !== null && i.severity !== "low") bySceneAll.set(i.scene, [...(bySceneAll.get(i.scene) ?? []), i]);
  const worst = [...bySceneAll.entries()]
    .sort((a, b) => Number(b[1].some((i) => i.severity === "high")) - Number(a[1].some((i) => i.severity === "high")) || b[1].length - a[1].length)
    .slice(0, MAX_AUTO_FIXES);
  const copyIssues = first.issues.filter((i) => i.scene === null && i.severity !== "low" && (i.area === "copy" || i.area === "cta" || i.area === "claims"));

  let current = script;
  const rewrittenScenes = await Promise.all(
    worst.map(async ([n, issues]) => {
      try {
        return { n, issues, scene: await regenerateScene({ script, sceneNumber: n, issues: issues.map((i) => `${i.problem} Fix: ${i.fix}`), ctx: rewriteCtx }) };
      } catch (error) {
        logger.warn("Could not rewrite a scene", { scene: n, error: error instanceof Error ? error.message : String(error) });
        return null;
      }
    }),
  );
  const scenes: VideoScene[] = current.scenes.map((s) => rewrittenScenes.find((r) => r?.n === s.number)?.scene ?? s);
  for (const r of rewrittenScenes) if (r) fixes.push({ target: `Scene ${r.n}`, reason: r.issues.map((i) => i.problem).join(" ").slice(0, 220) });
  // Rewritten lines change how long their scenes run, so the whole script is laid out again.
  const retimed = retime(scenes);
  current = { ...current, scenes: retimed, durationSeconds: retimed.length ? retimed[retimed.length - 1]!.end : 0 };

  if (copyIssues.length) {
    try {
      const adCopy = await rewriteAdCopy({ script: current, issues: copyIssues.map((i) => `${i.problem} Fix: ${i.fix}`), ctx: rewriteCtx });
      current = { ...current, adCopy };
      fixes.push({ target: "Ad copy", reason: copyIssues.map((i) => i.problem).join(" ").slice(0, 220) });
    } catch (error) {
      logger.warn("Could not rewrite the ad copy", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  // After the fixes, the rule checks run again (instant). The AI review ran once; its leftovers are kept only if nothing was fixed there.
  const warnings = checkScript(current, { corpus: ctx.corpus, assetIds: ctx.assetIds, target: ctx.target, claims: ctx.claims });
  const fixedScenes = new Set(fixes.filter((f) => f.target.startsWith("Scene")).map((f) => Number(f.target.slice(6))));
  const leftoverReview = first.issues.filter((i) => !warningsToIssues([i.problem]).length || !i.problem.startsWith("Scene")).filter((i) => i.scene === null ? !fixes.some((f) => f.target === "Ad copy") : !fixedScenes.has(i.scene));
  const issues = merge(warningsToIssues(warnings), leftoverReview.filter((i) => !/^Scene \d+ |^The ad copy|^Runs /.test(i.problem)));
  const open = issues.filter((i) => i.severity !== "low");

  return {
    ...current,
    warnings,
    verification: {
      score: first.score,
      verdict: open.length ? "needs_review" : fixes.length ? "fixed" : "passed",
      summary: first.summary,
      fixes,
      issues,
      checkedAt: new Date().toISOString(),
    },
  };
}

/** Verify every script, in parallel. A failure on one never loses the script: it is shown with its rule warnings. */
export async function verifyAndFixAll(scripts: VideoScript[], ctx: VerifyContext): Promise<VideoScript[]> {
  return Promise.all(
    scripts.map(async (s) => {
      try {
        return await verifyAndFix(s, ctx);
      } catch (error) {
        logger.warn("Script verification failed", { script: s.id, error: error instanceof Error ? error.message : String(error) });
        return s;
      }
    }),
  );
}
