import {
  PLACEMENT_OPTIONS,
  attributionOptionsFor,
  conversionLocationsFor,
  performanceGoalsFor,
  suggestCampaignSettings,
  type AttributionSetting,
  type CampaignObjective,
  type CampaignSettings,
  type ConversionLocation,
  type GoalInfo,
  type OptionInfo,
  type Suggestion,
} from "@/lib/meta/campaign-rules";

export type CampaignOptions = {
  accountId: string;
  objective: CampaignObjective;
  conversionLocations: OptionInfo<ConversionLocation>[];
  /** Keyed by conversion location id; Engagement / Awareness use the key "none". */
  performanceGoals: Record<string, GoalInfo[]>;
  /** Keyed by performance goal id. */
  attribution: Record<string, OptionInfo<AttributionSetting>[]>;
  pixels: { id: string; name: string; events: string[] }[];
  /** False when the pixel lookup failed: "no pixels" then means "unknown", not "none". */
  pixelsLoaded: boolean;
  pages: { id: string; name: string }[];
  leadForms: { id: string; name: string; page_id: string }[];
  leadFormsLoaded: boolean;
  devices: { id: string; name: string }[];
  osList: { id: string; name: string }[];
  placements: typeof PLACEMENT_OPTIONS;
  suggestion: Suggestion;
  warnings: string[];
};

export type CampaignOptionsDeps = {
  graph: { get<T>(path: string, params?: Record<string, string | number | boolean | null | undefined>): Promise<T> };
  listPages: (accountId: string) => Promise<{ id: string; name: string }[]>;
  /** Lead forms for a Page. Meta needs the Page's own token; without this, the user token is tried. */
  fetchLeadForms?: (pageId: string) => Promise<Array<{ id?: string; name?: string; status?: string }>>;
};

export type LoadCampaignOptionsInput = {
  clientId: string;
  accountId: string;
  objective: CampaignObjective;
  stated?: Partial<CampaignSettings>;
  /** Who is asking (user id). Cached lookups are never shared across scopes. */
  cacheScope?: string;
};

/**
 * The ad account to read: the one asked for only if it is mapped to this
 * client, otherwise the client's primary account. Never trusts the request.
 */
export function pickAllowedAccount(
  requested: string | null | undefined,
  allowed: string[],
  primary: string | null,
): string | null {
  const wanted = requested?.trim();
  if (!wanted) return primary;
  const normalized = normalizeAccountId(wanted);
  if (allowed.map(normalizeAccountId).includes(normalized)) return normalized;
  throw new Error("That ad account is not mapped to this client.");
}

/**
 * Keep the chosen pixel / lead form when still valid, otherwise pick the first
 * available one, and drop the ones the current goal does not use.
 */
export function withSourceIds(
  settings: CampaignSettings,
  ctx: {
    objective: CampaignObjective;
    pixels: { id: string }[];
    leadForms: { id: string }[];
  },
): CampaignSettings {
  const next: CampaignSettings = { ...settings };
  if (next.conversion_location === "instant_form" && ctx.leadForms.length) {
    if (!ctx.leadForms.some((f) => f.id === next.lead_form_id)) next.lead_form_id = ctx.leadForms[0]!.id;
  } else {
    delete next.lead_form_id;
  }
  const goal = performanceGoalsFor(ctx.objective, next.conversion_location).find(
    (g) => g.id === next.optimization_goal,
  );
  if (goal?.needsEvent && ctx.pixels.length) {
    if (!ctx.pixels.some((p) => p.id === next.pixel_id)) next.pixel_id = ctx.pixels[0]!.id;
  } else {
    delete next.pixel_id;
  }
  return next;
}

/** Shown when Meta's device / OS search is empty or fails. */
const FALLBACK_DEVICES = [
  { id: "iPhone", name: "iPhone" },
  { id: "iPad", name: "iPad" },
];
const FALLBACK_OS = [
  { id: "iOS", name: "iOS" },
  { id: "Android", name: "Android" },
];

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; value: Promise<unknown> }>();

export function resetCampaignOptionsCache(): void {
  cache.clear();
}

/** One cached lookup per account and kind; a failed lookup is not cached. */
function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as Promise<T>;
  const value = load();
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  return value;
}

function normalizeAccountId(id: string): string {
  return id.startsWith("act_") ? id : `act_${id}`;
}

/** Like settle, but also says whether the lookup worked. */
async function settleLoaded<T>(
  label: string,
  warnings: string[],
  work: Promise<T>,
  fallback: T,
): Promise<{ value: T; loaded: boolean }> {
  try {
    return { value: await work, loaded: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    warnings.push(`Couldn't load ${label} from Meta: ${reason}`);
    return { value: fallback, loaded: false };
  }
}

export async function loadCampaignOptions(
  input: LoadCampaignOptionsInput,
  deps: CampaignOptionsDeps,
): Promise<CampaignOptions> {
  const accountId = normalizeAccountId(input.accountId);
  const warnings: string[] = [];
  const { graph } = deps;

  const scope = input.cacheScope ?? "anon";
  const pixelsP = settleLoaded(
    "pixels",
    warnings,
    cached(`${scope}:${accountId}:pixels`, async () => {
      const list = await graph.get<{ data?: Array<{ id?: string; name?: string }> }>(
        `${accountId}/adspixels`,
        { fields: "id,name", limit: 25 },
      );
      return Promise.all(
        (list.data ?? [])
          .filter((p) => p.id)
          .map(async (p) => {
            let events: string[] = [];
            try {
              const stats = await graph.get<{ data?: Array<{ data?: Array<{ value?: string }> }> }>(
                `${p.id}/stats`,
                { aggregation: "event", start_time: Math.floor(Date.now() / 1000) - 7 * 86400 },
              );
              events = [
                ...new Set(
                  (stats.data ?? []).flatMap((row) => (row.data ?? []).map((d) => d.value ?? "")).filter(Boolean),
                ),
              ];
            } catch {
              // The pixel is still usable; the suggestion falls back to the standard event.
            }
            return { id: String(p.id), name: String(p.name ?? p.id), events };
          }),
      );
    }),
    [] as CampaignOptions["pixels"],
  );

  const pagesP = settleLoaded(
    "Pages",
    warnings,
    cached(`${scope}:${accountId}:pages`, () => deps.listPages(accountId)),
    [] as CampaignOptions["pages"],
  );

  const leadFormsP = pagesP.then(({ value: pages, loaded: pagesLoaded }) => {
    // Without the Pages there is nothing to look under: unknown, and not cached.
    if (!pagesLoaded) return { value: [] as CampaignOptions["leadForms"], loaded: false };
    return settleLoaded(
      "lead forms",
      warnings,
      cached(`${scope}:${accountId}:leadforms`, async () => {
        const forms: CampaignOptions["leadForms"] = [];
        for (const page of pages.slice(0, 5)) {
          const rows = deps.fetchLeadForms
            ? await deps.fetchLeadForms(page.id)
            : (
                await graph.get<{ data?: Array<{ id?: string; name?: string; status?: string }> }>(
                  `${page.id}/leadgen_forms`,
                  { fields: "id,name,status", limit: 25 },
                )
              ).data ?? [];
          for (const form of rows) {
            if (form.id && (!form.status || form.status === "ACTIVE")) {
              forms.push({ id: String(form.id), name: String(form.name ?? form.id), page_id: page.id });
            }
          }
        }
        return forms;
      }),
      [] as CampaignOptions["leadForms"],
    );
  });

  const targetingList = async (kind: "user_device" | "user_os", fallback: { id: string; name: string }[]) => {
    try {
      const res = await cached(`${scope}:${accountId}:${kind}`, () =>
        graph.get<{ data?: Array<{ name?: string }> }>("search", {
          type: "adTargetingCategory",
          class: kind,
          limit: 50,
        }),
      );
      // Meta can repeat a name, and sometimes returns the class itself as a row.
      const seen = new Set<string>();
      const rows = (res.data ?? [])
        .filter((r) => r.name && r.name !== kind)
        .map((r) => ({ id: String(r.name), name: String(r.name) }))
        .filter((r) => !seen.has(r.id) && seen.add(r.id));
      return rows.length ? rows : fallback;
    } catch {
      return fallback;
    }
  };

  const [pixelsRes, pagesRes, leadFormsRes, devices, osList] = await Promise.all([
    pixelsP,
    pagesP,
    leadFormsP,
    targetingList("user_device", FALLBACK_DEVICES),
    targetingList("user_os", FALLBACK_OS),
  ]);

  const { value: pixels, loaded: pixelsLoaded } = pixelsRes;
  const { value: pages } = pagesRes;
  const { value: leadForms, loaded: leadFormsLoaded } = leadFormsRes;

  const conversionLocations = conversionLocationsFor(input.objective);
  const performanceGoals: CampaignOptions["performanceGoals"] = {};
  if (conversionLocations.length) {
    for (const location of conversionLocations.filter((l) => l.supported)) {
      performanceGoals[location.id] = performanceGoalsFor(input.objective, location.id);
    }
  } else {
    performanceGoals.none = performanceGoalsFor(input.objective);
  }
  const attribution: CampaignOptions["attribution"] = {};
  for (const goals of Object.values(performanceGoals)) {
    for (const goal of goals) attribution[goal.id] = attributionOptionsFor(goal.id);
  }

  const pixelEvents = [...new Set(pixels.flatMap((p) => p.events))];
  // A failed lookup means "unknown", so it must not be treated as "none".
  const base = suggestCampaignSettings({
    objective: input.objective,
    hasPixel: pixels.length > 0 || !pixelsLoaded,
    hasLeadForm: leadForms.length > 0 || !leadFormsLoaded,
    pixelEvents,
    stated: input.stated,
  });
  const withIds = withSourceIds(base.settings, { objective: input.objective, pixels, leadForms });
  const reasons = { ...base.reasons };
  if (withIds.pixel_id && !reasons.pixel_id) {
    reasons.pixel_id = pixels.length === 1 ? "The only pixel on this account." : "The first pixel on this account.";
  }
  if (withIds.lead_form_id && !reasons.lead_form_id) {
    reasons.lead_form_id = leadForms.length === 1 ? "The only active lead form." : "The first active lead form.";
  }
  const suggestion: Suggestion = { settings: withIds, reasons };

  return {
    accountId,
    objective: input.objective,
    conversionLocations,
    performanceGoals,
    attribution,
    pixels,
    pixelsLoaded,
    pages,
    leadForms,
    leadFormsLoaded,
    devices,
    osList,
    placements: PLACEMENT_OPTIONS,
    suggestion,
    warnings,
  };
}
