/**
 * Multi-step Meta creates (video upload → campaign → ad set → creative → ad)
 * record each created ID so a failed run can be resumed without duplicating
 * what already exists in the ad account.
 */
export type CreateProgress = {
  video_id?: string;
  campaign_id?: string;
  adset_id?: string;
  creative_id?: string;
  ad_id?: string;
  /** Further ads in the same ad set, in order. */
  extra_ads?: Array<{ creative_id?: string; ad_id?: string; video_id?: string }>;
};

export type CreateProgressCallback = (
  progress: CreateProgress,
) => void | Promise<void>;

type ScalarKey = Exclude<keyof CreateProgress, "extra_ads">;

const LABELS: Array<[ScalarKey, string]> = [
  ["campaign_id", "campaign"],
  ["adset_id", "ad set"],
  ["creative_id", "creative"],
  ["ad_id", "ad"],
  ["video_id", "uploaded video"],
];

export function describeProgress(progress: CreateProgress | null | undefined): string {
  if (!progress) return "";
  return [
    ...LABELS.filter(([key]) => progress[key]).map(([key, label]) => `${label} ${progress[key]}`),
    ...(progress.extra_ads ?? []).flatMap((a, i) =>
      a?.ad_id ? [`extra ad ${i + 1} ${a.ad_id}`] : a?.creative_id ? [`extra creative ${i + 1} ${a.creative_id}`] : [],
    ),
  ].join(", ");
}

export function hasProgress(progress: CreateProgress | null | undefined): boolean {
  return Boolean(describeProgress(progress));
}

/** Read a CreateProgress back out of untrusted JSON (approval.execution_result). */
export function parseProgress(value: unknown): CreateProgress | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const out: CreateProgress = {};
  const id = (v: unknown) => (typeof v === "string" && /^\d+$/.test(v.trim()) ? v.trim() : undefined);
  for (const [key] of LABELS) {
    const v = id(row[key]);
    if (v) out[key] = v;
  }
  if (Array.isArray(row.extra_ads)) {
    out.extra_ads = row.extra_ads.map((a) => {
      const o = (a && typeof a === "object" ? a : {}) as Record<string, unknown>;
      return { creative_id: id(o.creative_id), ad_id: id(o.ad_id), video_id: id(o.video_id) };
    });
  }
  return hasProgress(out) ? out : null;
}

/**
 * A step of a multi-step create failed. `progress` lists what already exists
 * in Meta (all PAUSED) so the caller can persist it and resume later.
 */
export class PartialCreateError extends Error {
  readonly progress: CreateProgress;
  readonly step: string;

  constructor(step: string, cause: unknown, progress: CreateProgress) {
    const reason =
      cause instanceof Error ? cause.message : String(cause ?? "Unknown error");
    const created = describeProgress(progress);
    super(
      created
        ? `${step}: ${reason} Already created in Meta (PAUSED, not live): ${created}. Approving again after fixing this reuses them instead of creating duplicates.`
        : `${step}: ${reason}`,
    );
    this.name = "PartialCreateError";
    this.step = step;
    this.progress = { ...progress };
  }
}
