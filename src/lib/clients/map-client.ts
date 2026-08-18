import type { Client } from "@/types";

/** Map DB row (budget_ceiling dollars) → app Client (budget_ceiling_cents). */
export function mapClientRow(row: Record<string, unknown>): Client {
  const ceiling = row.budget_ceiling;
  const budget_ceiling_cents =
    typeof ceiling === "number"
      ? Math.round(ceiling * 100)
      : typeof ceiling === "string"
        ? Math.round(Number(ceiling) * 100)
        : null;

  return {
    id: String(row.id),
    name: String(row.name),
    slug: String(row.slug),
    website_url: (row.website_url as string | null) ?? null,
    industry: (row.industry as string | null) ?? null,
    brand_voice: (row.brand_voice as string | null) ?? null,
    brand_colors: (row.brand_colors as string[] | null) ?? null,
    brand_guidelines: (row.brand_guidelines as string | null) ?? null,
    target_audience: (row.target_audience as string | null) ?? null,
    value_proposition: (row.value_proposition as string | null) ?? null,
    budget_ceiling_cents: Number.isFinite(budget_ceiling_cents as number)
      ? (budget_ceiling_cents as number)
      : null,
    currency: String(row.currency ?? "USD"),
    notes: (row.notes as string | null) ?? null,
    is_demo: Boolean(row.is_demo),
    created_by: (row.created_by as string | null) ?? null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

/** App Client patch → DB columns (cents → dollars). */
export function toClientDbPatch(
  body: Partial<{
    name: string;
    slug: string;
    website_url: string | null;
    industry: string | null;
    brand_voice: string | null;
    brand_colors: string[] | null;
    brand_guidelines: string | null;
    target_audience: string | null;
    value_proposition: string | null;
    budget_ceiling_cents: number | null;
    currency: string;
    notes: string | null;
  }>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.slug !== undefined) patch.slug = body.slug;
  if (body.website_url !== undefined) patch.website_url = body.website_url;
  if (body.industry !== undefined) patch.industry = body.industry;
  if (body.brand_voice !== undefined) patch.brand_voice = body.brand_voice;
  if (body.brand_colors !== undefined) patch.brand_colors = body.brand_colors;
  if (body.brand_guidelines !== undefined)
    patch.brand_guidelines = body.brand_guidelines;
  if (body.target_audience !== undefined)
    patch.target_audience = body.target_audience;
  if (body.value_proposition !== undefined)
    patch.value_proposition = body.value_proposition;
  if (body.currency !== undefined) patch.currency = body.currency;
  if (body.notes !== undefined) patch.notes = body.notes;
  if (body.budget_ceiling_cents !== undefined) {
    patch.budget_ceiling =
      body.budget_ceiling_cents == null
        ? null
        : body.budget_ceiling_cents / 100;
  }
  return patch;
}
