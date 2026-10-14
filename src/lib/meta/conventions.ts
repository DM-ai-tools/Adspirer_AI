/**
 * Account hygiene defaults from the campaign-creation plan: one naming
 * convention, one UTM template, and how bid strategy and attribution are
 * sent to Meta.
 */

/** Meta fills the {{…}} macros at click time, so every ad reports itself. */
export const DEFAULT_URL_TAGS =
  "utm_source={{site_source_name}}&utm_medium={{placement}}&utm_campaign={{campaign.id}}&utm_content={{ad.id}}&utm_term={{adset.id}}";

export const BID_STRATEGIES = [
  "LOWEST_COST_WITHOUT_CAP",
  "COST_CAP",
  "LOWEST_COST_WITH_BID_CAP",
  "LOWEST_COST_WITH_MIN_ROAS",
] as const;

/** The client's attribution setting as Meta's attribution_spec. */
export const ATTRIBUTION_SPEC: Record<string, Array<{ event_type: string; window_days: number }>> = {
  "7d_click_1d_view": [
    { event_type: "CLICK_THROUGH", window_days: 7 },
    { event_type: "VIEW_THROUGH", window_days: 1 },
  ],
  "7d_click": [{ event_type: "CLICK_THROUGH", window_days: 7 }],
  "1d_click": [{ event_type: "CLICK_THROUGH", window_days: 1 }],
};

const OBJECTIVE_WORD: Record<string, string> = {
  OUTCOME_LEADS: "Leads",
  OUTCOME_SALES: "Sales",
  OUTCOME_TRAFFIC: "Traffic",
  OUTCOME_AWARENESS: "Awareness",
  OUTCOME_ENGAGEMENT: "Engagement",
  OUTCOME_APP_PROMOTION: "App",
};

/** "Implants from $99" → "ImplantsFrom99" (first `words` words, PascalCase). */
export function namePart(text: string | null | undefined, words = 3): string {
  return (text ?? "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .slice(0, words)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join("");
}

/** Country codes from the targeting locations; "Local" for radius-only targeting. */
export function geoCodes(locations: unknown): string[] {
  const codes = (Array.isArray(locations) ? locations : [])
    .map((l) => {
      if (typeof l === "string") return /^[A-Za-z]{2}$/.test(l.trim()) ? l.trim().toUpperCase() : null;
      if (l && typeof l === "object") {
        const o = l as Record<string, unknown>;
        const code = o.country_code ?? (o.type === "country" ? o.key : null);
        return typeof code === "string" ? code.toUpperCase() : null;
      }
      return null;
    })
    .filter((c): c is string => Boolean(c));
  return codes.length ? [...new Set(codes)] : ["Local"];
}

/** Broad (Advantage+ or no audiences), Custom (customer lists) or Interests. */
export function audienceLabel(args: Record<string, unknown>): string {
  const listed = (key: string) => Array.isArray(args[key]) && (args[key] as unknown[]).length > 0;
  if (listed("custom_audiences")) return "Custom";
  if (listed("interests") || listed("behaviors")) return "Interests";
  return "Broad";
}

/** Client_Objective_Audience_Geo_YYYYMM */
export function campaignNameByConvention(input: {
  client: string;
  objective: string;
  audience: string;
  geo: string[];
  date?: Date;
}): string {
  const d = input.date ?? new Date();
  const month = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  return [
    namePart(input.client, 4) || "Client",
    OBJECTIVE_WORD[input.objective] ?? namePart(input.objective),
    input.audience,
    input.geo.join("-"),
    month,
  ].join("_");
}

/** Audience_Geo */
export function adSetNameByConvention(args: Record<string, unknown>): string {
  return `${audienceLabel(args)}_${geoCodes(args.locations).join("-")}`;
}

/** Concept_Format_Hook: the headline, the format, the opening words of the copy. */
export function adNameByConvention(args: Record<string, unknown>, format: "Image" | "Video"): string {
  const concept = namePart(typeof args.headline === "string" ? args.headline : null) || "Ad";
  const hook = namePart(typeof args.primary_text === "string" ? args.primary_text : null);
  return [concept, format, hook].filter(Boolean).join("_");
}
