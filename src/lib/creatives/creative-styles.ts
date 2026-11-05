/**
 * The persuasion angles the concept writer draws from. Each concept in a batch is handed a
 * different ANGLE (what the ad argues) so the images say different things. How each one looks is
 * not fixed here: the model chooses a style per concept to suit the business and its angle.
 */

export type AdAngle = { key: string; name: string; brief: string };

export const AD_ANGLES: AdAngle[] = [
  { key: "pain", name: "Pain point", brief: "Name the frustration the viewer has right now, vividly, then point to the way out." },
  { key: "outcome", name: "Outcome / transformation", brief: "Show the result they want already achieved: the better after-state, not the product." },
  { key: "proof", name: "Social proof", brief: "Lead with trust: a real result, a number, a customer line or a track record taken from the page." },
  { key: "offer", name: "Offer / urgency", brief: "Make the offer itself the hero (free audit, trial, guarantee, deadline) and the reason to act now." },
  { key: "myth", name: "Myth-bust / contrarian", brief: "Challenge a common belief in the category and replace it with the smarter way." },
  { key: "curiosity", name: "Curiosity hook", brief: "Open a question or gap the viewer wants closed, so they have to read on or click." },
  { key: "how", name: "How it works", brief: "Make the simple process or mechanism obvious in one glance (3 steps, before to after)." },
  { key: "versus", name: "Us vs the old way", brief: "A direct contrast with the usual alternative: what they do now versus what this does." },
  { key: "authority", name: "Authority / expertise", brief: "Credentials, specialism and experience that make this the safe, expert choice." },
  { key: "identity", name: "Aspiration / identity", brief: "Speak to who the viewer wants to be or be seen as, and tie the offer to it." },
];

/** A small seeded shuffle, so a batch is varied but a given seed is repeatable. */
function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export type CreativePlan = { angle: AdAngle };

/**
 * One angle per concept, never repeated within the batch. Only the ANGLE (what the ad argues) is
 * assigned; the look of each image is left to the creative director model, which picks a style
 * to fit the business and the angle. `random` is injectable for tests.
 */
export function planCreativeSet(count: number, random: () => number = Math.random): CreativePlan[] {
  const n = Math.max(1, Math.min(count, AD_ANGLES.length));
  return shuffled(AD_ANGLES, random)
    .slice(0, n)
    .map((angle) => ({ angle }));
}
