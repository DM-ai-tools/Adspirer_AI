/**
 * One creative-fatigue rule for the optimiser, the audit and monitoring: an
 * ad is fatigued when its 7-day frequency is over the limit (the client's
 * prospecting limit, default 3) AND its link CTR fell 20%+ from the week
 * before — or, with no earlier week to compare, sits under 0.7%.
 */
export const FATIGUE = {
  minImpressions: 1000,
  ctrDrop: 0.2,
  ctrFloorWithoutHistory: 0.7,
  defaultFrequencyMax: 3,
} as const;

export function assessFatigue(
  input: { impressions: number; frequency7d: number | null; ctrNow: number; ctrBefore?: number | null },
  options: { frequencyMax?: number } = {},
): { fatigued: boolean; reason: string } {
  const max = options.frequencyMax ?? FATIGUE.defaultFrequencyMax;
  if (input.impressions < FATIGUE.minImpressions || input.frequency7d == null) {
    return { fatigued: false, reason: "Not enough delivery to judge." };
  }
  if (input.frequency7d <= max) {
    return { fatigued: false, reason: `7-day frequency ${input.frequency7d.toFixed(1)} is within ${max}.` };
  }
  const before = input.ctrBefore ?? null;
  if (before != null && before > 0) {
    const drop = (before - input.ctrNow) / before;
    return drop >= FATIGUE.ctrDrop
      ? {
          fatigued: true,
          reason: `Frequency ${input.frequency7d.toFixed(1)} in 7 days and link CTR down ${Math.round(drop * 100)}% (${before.toFixed(2)}% → ${input.ctrNow.toFixed(2)}%).`,
        }
      : { fatigued: false, reason: `Frequency is high but link CTR held (${before.toFixed(2)}% → ${input.ctrNow.toFixed(2)}%).` };
  }
  return input.ctrNow < FATIGUE.ctrFloorWithoutHistory
    ? {
        fatigued: true,
        reason: `Frequency ${input.frequency7d.toFixed(1)} in 7 days with link CTR ${input.ctrNow.toFixed(2)}% (under ${FATIGUE.ctrFloorWithoutHistory}%).`,
      }
    : { fatigued: false, reason: `Frequency is high but link CTR is ${input.ctrNow.toFixed(2)}%.` };
}

/** 3-second video plays ÷ impressions, as a %. Under 25% needs work; 25–35% solid; over 35% strong. */
export function hookRate(p: { impressions: number; videoViews3s?: number | null }): number | null {
  return p.videoViews3s != null && p.impressions > 0 ? (p.videoViews3s / p.impressions) * 100 : null;
}

/** ThruPlays ÷ 3-second plays, as a %. 40–50% is average; over 60% strong. */
export function holdRate(p: { videoViews3s?: number | null; thruplays?: number | null }): number | null {
  return p.thruplays != null && p.videoViews3s ? (p.thruplays / p.videoViews3s) * 100 : null;
}
