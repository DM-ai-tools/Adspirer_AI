/**
 * The hook angles a bulk run draws from.
 *
 * A bulk run makes many hooks over a few reused bodies, and the value is in the hooks testing
 * different reasons a prospect might care. So every angle here belongs to an awareness stage and
 * a kind of motivation, and a run takes each angle at most once. The set is deliberately larger
 * than one run (15) so successive runs can reach for different ones.
 */

export type AwarenessStage = "most_aware" | "product_aware" | "solution_aware" | "problem_aware" | "unaware";

export type BulkAngle = {
  key: string;
  name: string;
  stage: AwarenessStage;
  /** What the hook targets: a pain, a hope, an objection, a belief, or proof. */
  kind: "pain" | "hope" | "objection" | "belief" | "proof";
  brief: string;
};

export const STAGE_LABEL: Record<AwarenessStage, string> = {
  most_aware: "Most aware",
  product_aware: "Product aware",
  solution_aware: "Solution aware",
  problem_aware: "Problem aware",
  unaware: "Unaware",
};

export const BULK_ANGLES: BulkAngle[] = [
  // Most aware: they know the offer and need a reason to act now
  { key: "direct_offer", name: "The offer itself", stage: "most_aware", kind: "hope", brief: "State the offer plainly with what they get and the next step." },
  { key: "risk_reversal", name: "Remove the risk", stage: "most_aware", kind: "objection", brief: "Take away the fear of trying: guarantee, free first step, nothing to lose." },
  { key: "deadline", name: "Reason to act now", stage: "most_aware", kind: "hope", brief: "A real, accurate reason to act this week (only if the facts give one; otherwise the cost of waiting)." },
  { key: "social_proof", name: "Others like you", stage: "most_aware", kind: "proof", brief: "A real result, number or customer line from the facts, from someone like the viewer." },
  // Product aware: they know us, comparing options
  { key: "versus_alternative", name: "Us vs the usual alternative", stage: "product_aware", kind: "belief", brief: "Contrast with the usual way (a rival type, DIY, doing nothing) and why this wins." },
  { key: "authority", name: "Proven expertise", stage: "product_aware", kind: "proof", brief: "Credentials, specialism and track record that make this the safe expert choice." },
  { key: "objection_price", name: "Is it worth the cost?", stage: "product_aware", kind: "objection", brief: "Answer the cost objection with what the spend returns or replaces." },
  { key: "objection_time", name: "I haven't got the time", stage: "product_aware", kind: "objection", brief: "Show how little effort it takes, how quick the start is, who does the work." },
  { key: "behind_the_scenes", name: "How we actually work", stage: "product_aware", kind: "proof", brief: "Open the process up so the viewer sees competence and honesty." },
  // Solution aware: they know the category of solution, not us
  { key: "how_it_works", name: "How it works in 3 steps", stage: "solution_aware", kind: "belief", brief: "Make the mechanism obvious in one glance." },
  { key: "unique_mechanism", name: "The thing others miss", stage: "solution_aware", kind: "belief", brief: "Name the specific method or ingredient that makes this work when others do not." },
  { key: "outcome_after", name: "Life after", stage: "solution_aware", kind: "hope", brief: "Show the better after-state vividly, the result rather than the service." },
  { key: "mistake_to_avoid", name: "The costly mistake", stage: "solution_aware", kind: "pain", brief: "The common mistake people make when choosing or doing this, and how to avoid it." },
  { key: "checklist", name: "What to look for", stage: "solution_aware", kind: "belief", brief: "A useful standard for judging options that quietly favours this offer." },
  // Problem aware: they feel the pain but have not linked it to a solution
  { key: "daily_frustration", name: "The daily frustration", stage: "problem_aware", kind: "pain", brief: "Name the specific irritation they live with, in their own words." },
  { key: "hidden_cost", name: "What it's really costing you", stage: "problem_aware", kind: "pain", brief: "Make the hidden cost of the problem visible (money, time, missed chances)." },
  { key: "wasted_effort", name: "Working hard, going nowhere", stage: "problem_aware", kind: "pain", brief: "The feeling of effort with little to show, and the pattern behind it." },
  { key: "fear_falling_behind", name: "Falling behind", stage: "problem_aware", kind: "pain", brief: "Others are moving ahead; what that means for them." },
  { key: "myth_bust", name: "That's a myth", stage: "problem_aware", kind: "belief", brief: "Challenge a common belief that keeps them stuck and replace it." },
  // Unaware: they have not connected the problem to the category
  { key: "curiosity_gap", name: "A question they cannot ignore", stage: "unaware", kind: "belief", brief: "Open a gap or surprising fact that makes them want the answer." },
  { key: "dream_outcome", name: "The dream outcome", stage: "unaware", kind: "hope", brief: "Speak to the bigger hope behind the purchase, the life or business they want." },
  { key: "identity", name: "Who they want to be", stage: "unaware", kind: "hope", brief: "Tie the offer to the person or business they aspire to be seen as." },
  { key: "surprising_stat", name: "A number that stops you", stage: "unaware", kind: "proof", brief: "A striking true fact from the page or category that reframes the problem." },
  { key: "story_moment", name: "A moment you recognise", stage: "unaware", kind: "pain", brief: "A short, relatable scene that shows the problem without naming the product." },
];

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const STAGES: AwarenessStage[] = ["most_aware", "product_aware", "solution_aware", "problem_aware", "unaware"];

/**
 * `count` angles, none repeated, spread across the five awareness stages (an even share from each,
 * the remainder going to the broader middle stages) so a run does not only talk to people ready to buy.
 * Angles in `avoid` (used by earlier runs) are held back until the rest are used up.
 */
export function pickBulkAngles(count: number, options: { random?: () => number; avoid?: string[] } = {}): BulkAngle[] {
  const random = options.random ?? Math.random;
  const avoid = new Set(options.avoid ?? []);
  const n = Math.max(1, Math.min(count, BULK_ANGLES.length));
  const picked: BulkAngle[] = [];
  // Round-robin over the stages so each gets an even share; fresh angles are used up before any
  // an earlier run used.
  for (const wantFresh of [true, false]) {
    const pools = new Map<AwarenessStage, BulkAngle[]>();
    for (const stage of STAGES) {
      pools.set(stage, shuffled(BULK_ANGLES.filter((a) => a.stage === stage && avoid.has(a.key) !== wantFresh), random));
    }
    let progressed = true;
    while (picked.length < n && progressed) {
      progressed = false;
      for (const stage of STAGES) {
        const next = pools.get(stage)!.shift();
        if (next && picked.length < n) {
          picked.push(next);
          progressed = true;
        }
      }
    }
  }
  return shuffled(picked, random);
}
