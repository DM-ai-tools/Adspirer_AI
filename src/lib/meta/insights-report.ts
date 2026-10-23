import type { MetaInsightsQuery } from "@/lib/adspirer/provider";

/**
 * Helpers for the flexible Meta insights read (meta_insights): the Graph
 * parameters for a query, and Meta's rows made compact for the model.
 */

type GraphParams = Record<string, string | number>;

/** /act_X/insights parameters for a query; the account comes from the client, never the model. */
export function insightsParams(query: MetaInsightsQuery, pageSize: number): GraphParams {
  const params: GraphParams = {
    level: query.level,
    fields: query.fields.join(","),
    limit: pageSize,
  };
  if (query.breakdowns?.length) params.breakdowns = query.breakdowns.join(",");
  if (query.time_range) params.time_range = JSON.stringify(query.time_range);
  else params.date_preset = query.date_preset ?? "last_30d";
  if (query.time_increment != null) params.time_increment = String(query.time_increment);
  const filtering = [
    ...(query.campaign_ids?.length ? [{ field: "campaign.id", operator: "IN", value: query.campaign_ids }] : []),
    ...(query.adset_ids?.length ? [{ field: "adset.id", operator: "IN", value: query.adset_ids }] : []),
    ...(query.ad_ids?.length ? [{ field: "ad.id", operator: "IN", value: query.ad_ids }] : []),
  ];
  if (filtering.length) params.filtering = JSON.stringify(filtering);
  return params;
}

const NUMERIC = /^-?\d+(?:\.\d+)?$/;
/** Text fields that look numeric but must stay strings (ids, dates, breakdown values). */
const KEEP_TEXT = /(?:^|_)(?:id|ids|name|date_start|date_stop|age|gender|country|region|dma)$/;

/** [{ action_type, value }] → { action_type: number }. */
function flattenActions(list: unknown[]): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const { action_type, value } = entry as { action_type?: unknown; value?: unknown };
    if (typeof action_type !== "string") continue;
    const text = String(value ?? "");
    out[action_type] = NUMERIC.test(text) ? Number(text) : text;
  }
  return out;
}

/** One Meta insights row: numbers parsed, action lists flattened, ids and dates left as text. */
export function compactInsightsRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (Array.isArray(value)) out[key] = flattenActions(value);
    else if (typeof value === "string" && NUMERIC.test(value) && !KEEP_TEXT.test(key)) out[key] = Number(value);
    else out[key] = value;
  }
  return out;
}
