import type { CompetitorBrief, CompetitorBriefStatus } from "@/types";

/**
 * The app's CompetitorBrief and the `competitor_briefs` table name three
 * columns differently (client_service_id / service_id, raw_research /
 * source_metadata, generated_at / researched_at). Every Supabase read and
 * write of briefs goes through these two functions.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A row to insert. The id is left to the database (it is a uuid column). */
export function competitorBriefToRow(brief: CompetitorBrief): Record<string, unknown> {
  const serviceId = brief.client_service_id;
  return {
    client_id: brief.client_id,
    service_id: serviceId && UUID.test(serviceId) ? serviceId : null,
    status: brief.status,
    summary: brief.summary,
    strengths: brief.strengths,
    weaknesses: brief.weaknesses,
    messaging_themes: brief.messaging_themes,
    creative_patterns: brief.creative_patterns,
    opportunities: brief.opportunities,
    source_metadata: brief.raw_research,
    researched_at: brief.generated_at,
    created_at: brief.created_at,
    updated_at: brief.updated_at,
  };
}

const list = (v: unknown): string[] | null => (Array.isArray(v) ? v.map(String) : null);
const text = (v: unknown): string | null => (typeof v === "string" ? v : null);

export function competitorBriefFromRow(row: Record<string, unknown>): CompetitorBrief {
  const meta = row.source_metadata;
  return {
    id: String(row.id),
    client_id: String(row.client_id),
    client_service_id: text(row.service_id),
    status: (text(row.status) ?? "pending") as CompetitorBriefStatus,
    summary: text(row.summary),
    strengths: list(row.strengths),
    weaknesses: list(row.weaknesses),
    messaging_themes: list(row.messaging_themes),
    creative_patterns: list(row.creative_patterns),
    opportunities: list(row.opportunities),
    raw_research: meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as Record<string, unknown>) : null,
    generated_at: text(row.researched_at),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}
