/** Small pure helpers for the ad copy editor and the run header (client-safe). */

/** The most each field may hold (what Meta publishing allows); the copy editor enforces these. */
export const COPY_FIELD_LIMITS = { headline: 255, primary_text: 2200, description: 255 } as const;

/** The character counter shown under a field in the ad copy editor. */
export function counterState(text: string, max: number): { count: number; over: boolean; label: string } {
  const count = text.length;
  return { count, over: count > max, label: `${count} / ${max}` };
}

/** The ad copy line in the run header, or null when no ad copy instructions were given. */
export function copyHeaderLine(copy: { status: "writing" | "ready" | "failed"; message: string | null; repaired: number; flagged: number } | null): string | null {
  if (!copy) return null;
  if (copy.status === "writing") return "Writing the ad copy to your instructions…";
  if (copy.status === "failed") return copy.message ?? "The ad copy could not be written, so each ad keeps the words printed on its image.";
  const parts = ["Ad copy written to your instructions"];
  if (copy.repaired) parts.push(`${copy.repaired} ad${copy.repaired === 1 ? "" : "s"} needed a rewrite to follow them`);
  if (copy.flagged) parts.push(`${copy.flagged} still ${copy.flagged === 1 ? "has" : "have"} a note`);
  return `${parts.join("; ")}.`;
}
