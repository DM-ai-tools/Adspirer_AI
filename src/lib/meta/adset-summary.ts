/** A one-line description of an ad set's audience, from the targeting Meta returned. */
export function summariseTargeting(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const t = JSON.parse(raw) as {
      geo_locations?: { countries?: string[]; cities?: unknown[]; regions?: unknown[]; custom_locations?: unknown[] };
      age_min?: number;
      age_max?: number;
      genders?: number[];
      custom_audiences?: unknown[];
      flexible_spec?: unknown[];
    };
    const parts: string[] = [];
    const geo = t.geo_locations;
    if (geo?.countries?.length) parts.push(geo.countries.join(", "));
    else if (geo?.cities?.length || geo?.regions?.length || geo?.custom_locations?.length) parts.push("specific places");
    if (t.age_min || t.age_max) parts.push(`age ${t.age_min ?? 18}–${t.age_max ?? "65+"}`);
    if (t.genders?.length === 1) parts.push(t.genders[0] === 1 ? "men" : "women");
    if (t.custom_audiences?.length) parts.push(`${t.custom_audiences.length} custom audience${t.custom_audiences.length > 1 ? "s" : ""}`);
    if (t.flexible_spec?.length) parts.push("interest targeting");
    return parts.length ? parts.join(" · ") : null;
  } catch {
    return null;
  }
}
