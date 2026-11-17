import type { AuditChange, MetaAuditSnapshot } from "@/lib/audit/meta-audit-data";

/** The reports always say this: the edit history can miss things, and old settings can't be rebuilt. */
export const MEASUREMENT_LIMITATION =
  "Meta's activity history may not record every attribution or dataset edit, and earlier ad set attribution settings can't be recovered.";

export type MeasurementBreak = {
  date: string;
  window: "current" | "previous";
  what: string;
  objectName: string | null;
  eventType: string;
};

const MEASUREMENT_EVENT = /attribution|promoted_object|optimization_goal|pixel|dataset|conversion/i;

function isMeasurementChange(c: AuditChange): boolean {
  return MEASUREMENT_EVENT.test(c.eventType) || (c.detail ?? "").includes("attribution_spec");
}

/**
 * Edits to attribution, the optimisation event or the pixel/dataset. Any of these changes what
 * "a result" means, so a metric that moves around them is a measurement break, not a performance
 * change. Best effort: it only sees what Meta's activity history recorded.
 */
export function measurementBreaks(snapshot: MetaAuditSnapshot): MeasurementBreak[] {
  const prev = snapshot.previousPeriod;
  return (snapshot.changes ?? [])
    .filter(isMeasurementChange)
    .map((c) => ({
      date: c.localDate,
      window:
        prev && c.localDate >= prev.since && c.localDate <= prev.until
          ? ("previous" as const)
          : ("current" as const),
      what: c.label ?? c.eventType,
      objectName: c.objectName,
      eventType: c.eventType,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Active ad sets in the same objective that run different attribution windows. Their results
 * are counted differently, so they aren't strictly comparable. A caveat, not a break: nothing
 * changed during the windows.
 */
export function measurementCaveats(snapshot: MetaAuditSnapshot): string[] {
  const objectiveOf = new Map(snapshot.campaigns.map((c) => [c.id, c.objective]));
  const byObjective = new Map<string, Set<string>>();
  for (const a of snapshot.adSets) {
    if (a.status !== "ACTIVE" || a.attributionWindows.length === 0) continue;
    const objective = objectiveOf.get(a.campaignId);
    if (!objective) continue;
    const key = [...a.attributionWindows].sort().join(" + ");
    const set = byObjective.get(objective) ?? new Set<string>();
    set.add(key);
    byObjective.set(objective, set);
  }
  const caveats: string[] = [];
  for (const [objective, windows] of byObjective) {
    if (windows.size > 1) {
      caveats.push(
        `Active ${objective} ad sets use different attribution windows (${[...windows].join("; ")}), so their results are not counted the same way.`,
      );
    }
  }
  return caveats;
}

/** The "Measurement settings" block that goes in every analysis report's evidence. */
export function renderMeasurementEvidence(snapshot: MetaAuditSnapshot): string {
  const live = snapshot.adSets.filter((a) => a.status === "ACTIVE");
  const sets = live.length > 0 ? live : snapshot.adSets;
  const windows = [...new Set(sets.flatMap((a) => a.attributionWindows))];
  const events = [
    ...new Set(
      sets
        .map((a) => [a.optimizationGoal, a.customEventType].filter(Boolean).join(" / "))
        .filter(Boolean),
    ),
  ];
  const breaks = measurementBreaks(snapshot);
  const caveats = measurementCaveats(snapshot);
  const lines = [
    "### Measurement settings",
    `- Attribution windows in use: ${windows.length > 0 ? windows.join(", ") : "Not available (Meta returned none)"}`,
    `- Optimisation events: ${events.length > 0 ? events.join("; ") : "Not available"}`,
  ];
  if (breaks.length === 0) {
    lines.push("- Measurement breaks: none recorded in the activity history.");
  } else {
    lines.push("- MEASUREMENT BREAKS (do not call a change around these a performance change):");
    for (const b of breaks) {
      lines.push(
        `  - ${b.date} (${b.window} window): ${b.what}${b.objectName ? ` on ${b.objectName}` : ""} [${b.eventType}]`,
      );
    }
  }
  for (const c of caveats) lines.push(`- Measurement caveat: ${c}`);
  lines.push(`- Limitation: ${MEASUREMENT_LIMITATION}`);
  return lines.join("\n");
}
