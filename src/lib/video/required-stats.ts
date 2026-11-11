import { figureRoundsTo, figuresEquivalent, findClaimsInText, normaliseFigure } from "@/lib/video/claims";
import type { ImageStatCoverage } from "@/lib/video/script-types";
import type { VideoScene, VideoScript } from "@/lib/video/script";

/**
 * An uploaded stat image is uploaded for its headline: the ONE main stat in it must be said in the
 * script, naturally, in a scene that shows that image. (A screenshot can print a dozen figures, and a
 * script that recites them all stops sounding like a person: the others are on screen in the image for
 * anyone who looks, and may be mentioned when the argument needs them, but are not required.) This
 * module works out which stat is the main one and whether a script covers it. Pure.
 */

export type RequiredStat = { assetId: string; assetName: string; value: string; label: string };

type StatLike = { value: string; label: string };

/** Labels that mark a headline result, best first: the outcome a viewer cares about, then supporting results, then volume. */
const HEADLINE: RegExp[] = [
  /\broas\b|return on (?:ad )?spend|\broi\b|value ?\/ ?cost|per dollar|per \$/i,
  /revenue|sales|profit|income|conv(?:ersion)?\.? value|growth|increase|saved|savings|leads|bookings|rating/i,
  /conversions?|orders|customers|clients|reviews?/i,
];

/**
 * The one stat an image makes its point with. The model's choice wins when it names one of the stats
 * actually read from the image (so the operator's override, which sets it, always wins too); otherwise
 * the most outcome-like label, then the first stat printed.
 */
export function pickMainStat(stats: StatLike[], preferred?: StatLike | null): StatLike | null {
  const usable = stats.filter((s) => s.value.trim());
  if (!usable.length) return null;
  const key = (v: string) => v.replace(/\s+/g, "").toLowerCase();
  if (preferred?.value) {
    const hit = usable.find((s) => key(s.value) === key(preferred.value));
    if (hit) return hit;
  }
  for (const re of HEADLINE) {
    const hit = usable.find((s) => re.test(s.label));
    if (hit) return hit;
  }
  return usable[0]!;
}

/** The one required stat of each image that carries any. */
export function requiredStatsFrom(images: Array<{ id: string; name: string; stats: StatLike[]; mainStat?: StatLike | null }>): RequiredStat[] {
  const out: RequiredStat[] = [];
  for (const image of images) {
    const main = pickMainStat(image.stats, image.mainStat);
    if (main) out.push({ assetId: image.id, assetName: image.name, value: main.value.trim(), label: main.label.trim() });
  }
  return out;
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9.%$]+/g, "");

/** True when a spoken line states this figure: as written, or as the same figure said another way ("26.5 million" for "26.5M"). */
export function lineStatesFigure(line: string, value: string): boolean {
  if (!line.trim() || !value.trim()) return false;
  if (squash(line).includes(squash(value))) return true;
  const target = normaliseFigure(value);
  // The same figure, or the figure rounded the way a person says it ("about $13.6 million" for $13,580,509.69).
  return findClaimsInText(line).some((c) => {
    const said = normaliseFigure(c.figure);
    return figuresEquivalent(said, target) || figureRoundsTo(said, target);
  });
}

/** How a precise figure is naturally said: "13,580,509.69" as "13.6 million", "767,628.34" as "768 thousand". Empty for a figure that is already short. */
export function spokenForms(value: string): string[] {
  const n = normaliseFigure(value);
  if (n.value === null || n.unit === "percent" || n.unit === "multiple") return [];
  if (n.text.replace(/\D/g, "").replace(/^0+/, "").length < 5) return [];
  const v = Math.abs(n.value);
  const cur = n.unit === "money" ? "$" : "";
  const out: string[] = [];
  if (v >= 1_000_000) {
    for (const d of [1, 2]) {
      const m = (v / 1_000_000).toFixed(d).replace(/\.0+$/, "");
      out.push(`${cur}${m} million`, `${cur}${m}M`, `${m} million`, `${m}M`);
    }
  } else if (v >= 10_000) {
    const k = Math.round(v / 1000);
    out.push(`${cur}${k} thousand`, `${cur}${k}K`, `${k} thousand`, `${k}K`, `${cur}${(v / 1000).toFixed(1)}K`);
  }
  return [...new Set(out)];
}

export function statCoverage(script: Pick<VideoScript, "scenes">, required: RequiredStat[]): ImageStatCoverage[] {
  return required.map((r) => {
    const saying = script.scenes.filter((s) => lineStatesFigure(s.line, r.value));
    // Prefer the scene that says it AND shows its image.
    const best: VideoScene | undefined = saying.find((s) => s.assetId === r.assetId) ?? saying[0];
    return { assetId: r.assetId, assetName: r.assetName, value: r.value, label: r.label, said: Boolean(best), shown: Boolean(best && best.assetId === r.assetId), scene: best?.number ?? null };
  });
}

/** The stats still to be said, and those said in a scene that does not show their image. */
export function statGaps(coverage: ImageStatCoverage[]): { unsaid: ImageStatCoverage[]; unshown: ImageStatCoverage[] } {
  return { unsaid: coverage.filter((c) => !c.said), unshown: coverage.filter((c) => c.said && !c.shown) };
}

/** What the writer is told, in its own words, when stats are missing or not shown with their image. Null when all is covered. */
export function statFixNote(coverage: ImageStatCoverage[]): string | null {
  const { unsaid, unshown } = statGaps(coverage);
  if (!unsaid.length && !unshown.length) return null;
  const list = (items: ImageStatCoverage[]) => items.map((c) => `${c.value} (${c.label || "as printed in the image"}, image ${c.assetId})`).join("; ");
  const hint = (items: ImageStatCoverage[]) => items.map((c) => ({ c, f: spokenForms(c.value)[0] })).filter((x) => x.f).map((x) => `${x.c.value} can be said as "${x.f}"`).join("; ");
  return [
    unsaid.length ? `THE LAST DRAFT LEFT OUT A MAIN STAT THAT MUST BE SAID: ${list(unsaid)}${hint(unsaid) ? ` (${hint(unsaid)})` : ""}. The operator uploaded the image for this figure, so it has to be spoken naturally in a scene that shows that image: set that scene's asset_id and stat. Say the figure and what it measures in plain words where the argument needs the proof. Do not add the image's other numbers.` : null,
    unshown.length ? `THESE STATS ARE SAID BUT THEIR IMAGE IS NOT SHOWN IN THAT SCENE: ${list(unshown)}. Set asset_id on the scene that says them.` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

/** The prompt block that makes the requirement part of the first draft. Null when no uploaded image carries stats. */
export function requiredStatsPrompt(required: RequiredStat[], summaries: Record<string, string> = {}): string | null {
  if (!required.length) return null;
  const byImage = new Map<string, RequiredStat[]>();
  for (const r of required) byImage.set(r.assetId, [...(byImage.get(r.assetId) ?? []), r]);
  const lines = [...byImage.entries()].map(([id, list]) => `- image ${id} (${list[0]!.assetName}${summaries[id] ? `, which shows: ${summaries[id]}` : ""}): ${list.map((r) => `${r.value}${r.label ? ` ${r.label}` : ""}${spokenForms(r.value)[0] ? ` (say as ${spokenForms(r.value)[0]})` : ""}`).join("; ")}`);
  return [
    "THE MAIN STAT OF EACH OF THE OPERATOR'S IMAGES (MANDATORY). The operator uploaded each image for its headline figure, so the script MUST say that figure, naturally, as part of the argument. Only this one figure per image is required; the other numbers printed in an image are not, and reciting them would make the script sound like a report:",
    ...lines,
    "Rules: say the figure and what it measures in plain words, in the scene where the proof helps the argument most (usually after the claim it supports, not as an opener); on that scene set asset_id to the image and stat to that figure, so the person finishing the video knows which image belongs with it. The video itself shows no image: the line must make complete sense with nothing on screen. Say each figure the way a person would round it, as digits (for example 13,580,509.69 becomes '$13.6 million' and 767,628.34 becomes '768 thousand'; a rounding of up to 1.5% is accepted, and a short figure like 5.25 is said exactly). Say a figure only as what the image shows: do NOT add a period (such as 'this month' or 'last year'), whose it is (such as 'our clients' or 'businesses like yours'), a currency the image does not show, or any comparison the image does not give; 'in one account's results' or 'in these results' is honest. Never point at the image ('shown here', 'as you can see', 'on screen'), and call each figure what the image itself labels it (a conversion value is not sales revenue). Do not turn the figures into a list read out, do not change a figure, and do not use the same image for a different point.",
  ].join("\n");
}

/** The script with its image-stat coverage recorded (what is said, what is shown, in which scene). */
export function attachImageStats(script: VideoScript, required: RequiredStat[]): VideoScript {
  if (!required.length) return script.imageStats ? { ...script, imageStats: undefined } : script;
  return { ...script, imageStats: statCoverage(script, required) };
}

/**
 * A stat image is shown while its main stat is said, and only then. A scene that says the figure
 * shows that image (set here if the writer forgot); a scene that carries the image of a stat it does
 * not say loses it (a writer tends to put the image on every scene, which would leave it on screen
 * the whole video). Scenes the operator edited are left alone, and an image with no required stat is
 * left wherever it was put.
 */
export function linkImageStats(scenes: VideoScene[], required: RequiredStat[]): VideoScene[] {
  if (!required.length) return scenes;
  const byAsset = new Map(required.map((r) => [r.assetId, r]));
  return scenes.map((s) => {
    if (s.edited) return s;
    // A scene that says a figure shows that figure's image (even if the writer put another one on it).
    const hit = required.find((r) => lineStatesFigure(s.line, r.value));
    if (hit) return { ...s, assetId: hit.assetId, stat: s.assetId === hit.assetId ? (s.stat ?? hit.value) : hit.value };
    const own = s.assetId ? byAsset.get(s.assetId) : undefined;
    if (own) {
      // This scene shows an image whose main stat it does not say.
      const stat = s.stat && s.stat.replace(/\s+/g, "").toLowerCase() === own.value.replace(/\s+/g, "").toLowerCase() ? null : s.stat;
      return { ...s, assetId: null, stat };
    }
    return s;
  });
}
