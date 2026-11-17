import type { ResolvedGoals } from "@/lib/clients/goals";

/** Bump when a note below changes, so a strategy can say which notes it was written against. */
export const PLATFORM_NOTES_VERSION = "2026-11";

/** Platform facts the strategy writers lean on, one plain sentence each. */
export const PLATFORM_NOTES: string[] = [
  "Meta's learning phase needs about 50 optimisation events a week per ad set; ad sets that get fewer stay in learning.",
  "Raise or lower a budget in steps of 20-30% every 3-4 days; a bigger jump resets learning.",
  "Editing targeting, creative or the optimisation event on an ad set also resets learning.",
  "Advantage+ sales and leads campaigns are Meta's default build for those goals.",
  "View-through attribution inflates reported results; compare results on the same attribution setting.",
];

/** The static notes plus the frequency limits this client has set. */
export function platformNotes(goals: ResolvedGoals): string[] {
  return [
    ...PLATFORM_NOTES,
    `Frequency limits for this account: prospecting up to ${goals.policy.prospecting_frequency_max}, retargeting up to ${goals.policy.retargeting_frequency_max} per person in the period.`,
  ];
}
