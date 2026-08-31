/**
 * Types + parsers for Adspirer custom audiences and Meta detailed targeting.
 * IDs stay under the hood; the UI shows names for operators to pick.
 */

export type MetaCustomAudience = {
  id: string;
  name: string;
  subtype?: string | null;
  approximate_count?: number | null;
  delivery_status?: string | null;
};

export type MetaTargetingSearchType =
  | "interest"
  | "behavior"
  | "demographic"
  | "life_event"
  | "location"
  | "locale"
  | "employer"
  | "job_title"
  | "school"
  | "major";

export type MetaTargetingOption = {
  id: string;
  name: string;
  type: MetaTargetingSearchType | string;
  audience_size?: number | null;
  path?: string | null;
  /** Location-only extras when present. */
  country_code?: string | null;
  key?: string | null;
};

export type TargetingLocationSelection = {
  id?: string;
  name: string;
  key?: string;
  /** country | region | city | zip | place */
  type?: string;
  country_code?: string | null;
  /** Radius only applies to city / region / zip / place keys. */
  radius?: number | null;
  distance_unit?: "kilometer" | "mile" | null;
};

export type CampaignTargetingSelection = {
  custom_audiences: Array<{ id: string; name: string }>;
  excluded_custom_audiences: Array<{ id: string; name: string }>;
  interests: Array<{ id: string; name: string }>;
  behaviors: Array<{ id: string; name: string }>;
  locations: TargetingLocationSelection[];
  /** facebook | instagram | audience_network | messenger — empty = Advantage+ */
  publisher_platforms: string[];
};

/** Meta location keys that support a radius (cities only). */
const RADIUS_LOCATION_TYPES = new Set(["city"]);

export function emptyTargetingSelection(): CampaignTargetingSelection {
  return {
    custom_audiences: [],
    excluded_custom_audiences: [],
    interests: [],
    behaviors: [],
    locations: [],
    publisher_platforms: [],
  };
}

/** Flatten selection into create_meta_*_campaign / add_meta_ad_set args. */
export function targetingSelectionToCreateArgs(
  selection: CampaignTargetingSelection,
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  if (selection.custom_audiences.length) {
    args.custom_audiences = selection.custom_audiences.map((a) => a.id);
  }
  if (selection.excluded_custom_audiences.length) {
    args.excluded_custom_audiences = selection.excluded_custom_audiences.map(
      (a) => a.id,
    );
  }
  if (selection.interests.length) {
    args.interests = selection.interests.map((i) => ({
      id: i.id,
      name: i.name,
    }));
  }
  if (selection.behaviors.length) {
    args.behaviors = selection.behaviors.map((b) => ({
      id: b.id,
      name: b.name,
    }));
  }
  if (selection.locations.length) {
    args.locations = selection.locations.map((l) => {
      const key = (l.key ?? l.id ?? "").trim();
      const type = (l.type ?? "").toLowerCase();
      // Countries go through as plain 2-letter codes; anything else must carry
      // its `type`, or Adspirer reads the key as a country code and Meta rejects it.
      if (type === "country" || (!type && /^[a-z]{2}$/i.test(key))) {
        return key.toUpperCase();
      }
      if (!key) return l.name;
      const radius =
        typeof l.radius === "number" && l.radius > 0 ? l.radius : null;
      const resolvedType = type || "city";
      return {
        key,
        type: resolvedType,
        ...(radius && RADIUS_LOCATION_TYPES.has(resolvedType)
          ? { radius, distance_unit: l.distance_unit ?? "kilometer" }
          : {}),
      };
    });
  }
  if (selection.publisher_platforms.length) {
    args.publisher_platforms = selection.publisher_platforms;
  }
  return args;
}

export function parseCustomAudiences(data: {
  text: string;
  structured?: Record<string, unknown> | null;
}): MetaCustomAudience[] {
  const structured = data.structured;
  const fromStructured = pickAudienceArray(structured);
  if (fromStructured.length) return fromStructured;

  // Some tools nest under data / audiences / results.
  if (structured && typeof structured === "object") {
    for (const key of ["data", "result", "results", "payload"]) {
      const nested = structured[key];
      if (nested && typeof nested === "object") {
        const found = pickAudienceArray(nested as Record<string, unknown>);
        if (found.length) return found;
      }
    }
  }

  return parseAudiencesFromText(data.text ?? "");
}

export function parseTargetingOptions(
  data: { text: string; structured?: Record<string, unknown> | null },
  searchType: string,
): MetaTargetingOption[] {
  const structured = data.structured;
  const fromStructured = pickTargetingArray(structured, searchType);
  if (fromStructured.length) return fromStructured;

  if (structured && typeof structured === "object") {
    for (const key of ["data", "result", "results", "payload", "targeting"]) {
      const nested = structured[key];
      if (nested && typeof nested === "object") {
        const found = pickTargetingArray(
          nested as Record<string, unknown>,
          searchType,
        );
        if (found.length) return found;
      }
    }
  }

  return parseTargetingFromText(data.text ?? "", searchType);
}

function pickAudienceArray(
  structured: Record<string, unknown> | null | undefined,
): MetaCustomAudience[] {
  if (!structured) return [];
  const candidates = [
    structured.audiences,
    structured.custom_audiences,
    structured.items,
    structured.results,
  ];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate) || !candidate.length) continue;
    const mapped = candidate
      .map((row) => mapAudienceRow(row))
      .filter((a): a is MetaCustomAudience => Boolean(a));
    if (mapped.length) return mapped;
  }
  return [];
}

function mapAudienceRow(row: unknown): MetaCustomAudience | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const id = String(r.id ?? r.audience_id ?? r.custom_audience_id ?? "").trim();
  const name = String(r.name ?? r.audience_name ?? "").trim();
  if (!id || !name) return null;
  const count =
    typeof r.approximate_count === "number"
      ? r.approximate_count
      : typeof r.approximate_count_lower_bound === "number"
        ? r.approximate_count_lower_bound
        : typeof r.size === "number"
          ? r.size
          : null;
  return {
    id,
    name,
    subtype:
      typeof r.subtype === "string"
        ? r.subtype
        : typeof r.type === "string"
          ? r.type
          : null,
    approximate_count: count,
    delivery_status:
      typeof r.delivery_status === "string"
        ? r.delivery_status
        : typeof r.status === "string"
          ? r.status
          : null,
  };
}

function pickTargetingArray(
  structured: Record<string, unknown> | null | undefined,
  searchType: string,
): MetaTargetingOption[] {
  if (!structured) return [];
  const candidates = [
    structured.options,
    structured.targeting,
    structured.results,
    structured.items,
    structured.interests,
    structured.behaviors,
    structured.locations,
  ];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate) || !candidate.length) continue;
    const mapped = candidate
      .map((row) => mapTargetingRow(row, searchType))
      .filter((a): a is MetaTargetingOption => Boolean(a));
    if (mapped.length) return mapped;
  }
  return [];
}

function mapTargetingRow(
  row: unknown,
  searchType: string,
): MetaTargetingOption | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const id = String(
    r.id ?? r.key ?? r.targeting_id ?? r.interest_id ?? "",
  ).trim();
  const name = String(r.name ?? r.label ?? r.title ?? "").trim();
  if (!id || !name) return null;
  const size =
    typeof r.audience_size === "number"
      ? r.audience_size
      : typeof r.audience_size_lower_bound === "number"
        ? r.audience_size_lower_bound
        : typeof r.reach === "number"
          ? r.reach
          : null;
  const path = Array.isArray(r.path)
    ? r.path.map(String).join(" > ")
    : typeof r.path === "string"
      ? r.path
      : typeof r.topic === "string"
        ? r.topic
        : // Locations describe themselves with region / country instead.
          [
            typeof r.region === "string" ? r.region : null,
            typeof r.country_name === "string" ? r.country_name : null,
          ]
            .filter(Boolean)
            .join(", ") || null;
  return {
    id,
    name,
    type: typeof r.type === "string" ? r.type : searchType,
    audience_size: size,
    path: path && path !== name ? path : null,
    country_code:
      typeof r.country_code === "string"
        ? r.country_code
        : typeof r.country === "string"
          ? r.country
          : null,
    key: typeof r.key === "string" ? r.key : id,
  };
}

type TableRow = Record<string, string>;

/**
 * Adspirer formats most list tools as markdown tables and only sometimes sends
 * `structured`. Read the table so audiences/targeting still resolve from text.
 */
export function parseMarkdownTableRows(text: string): TableRow[] {
  const rows: TableRow[] = [];
  let headers: string[] | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("|")) {
      headers = null;
      continue;
    }
    const cells = line
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim().replace(/`/g, "").replace(/\*\*/g, "").trim());
    if (!cells.length) continue;
    if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) continue;
    if (!headers) {
      headers = cells.map((cell) => cell.toLowerCase());
      continue;
    }
    const row: TableRow = {};
    cells.forEach((cell, index) => {
      row[headers?.[index] ?? `col${index}`] = cell;
    });
    rows.push(row);
  }
  return rows;
}

/** "1,900" -> 1900, "-1" / "N/A" -> null, "1,083,752,219 - 1,274,492,610" -> lower bound. */
function parseTableCount(value: string | undefined): number | null {
  if (!value) return null;
  const first = value.split(/[-–]/)[0]?.replace(/[^0-9]/g, "");
  if (!first) return null;
  const n = Number(first);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function parseAudiencesFromText(text: string): MetaCustomAudience[] {
  const fromTable: MetaCustomAudience[] = [];
  for (const row of parseMarkdownTableRows(text)) {
    const id = (row.id ?? row["audience id"] ?? "").trim();
    const name = (row.name ?? row.audience ?? "").trim();
    if (!/^\d{5,}$/.test(id) || !name) continue;
    fromTable.push({
      id,
      name: name.replace(/\.{3}$/, "…"),
      subtype: row.type || row.subtype || null,
      approximate_count: parseTableCount(row.size ?? row["audience size"]),
      delivery_status: row.status || row["delivery status"] || null,
    });
  }
  if (fromTable.length) return fromTable;

  const out: MetaCustomAudience[] = [];
  const lines = text.split("\n");
  for (const line of lines) {
    // "- Website Visitors (id: 12033…) · LOOKALIKE · ~12,000"
    const m = line.match(
      /[-*]\s*(.+?)\s*(?:\(|·|-)\s*(?:id[:\s]*)?(\d{5,})/i,
    );
    if (m) {
      out.push({
        id: m[2],
        name: m[1].replace(/\*\*/g, "").trim(),
      });
      continue;
    }
    const m2 = line.match(/`(\d{5,})`\s*[·:—-]\s*(.+)/);
    if (m2) {
      out.push({ id: m2[1], name: m2[2].trim() });
    }
  }
  return out;
}

function parseTargetingFromText(
  text: string,
  searchType: string,
): MetaTargetingOption[] {
  const fromTable: MetaTargetingOption[] = [];
  for (const row of parseMarkdownTableRows(text)) {
    const name = (row.name ?? row.location ?? row.option ?? "").trim();
    const id = (row.id ?? row.key ?? "").trim();
    if (!name || !id) continue;
    const type = (row.type || searchType).toLowerCase();
    const region = row.region && row.region !== "N/A" ? row.region : null;
    const country = row.country && row.country !== "N/A" ? row.country : null;
    fromTable.push({
      id,
      name,
      type,
      audience_size: parseTableCount(row["audience size"] ?? row.size),
      path:
        row.category && row.category !== name
          ? row.category
          : [region, country].filter(Boolean).join(", ") || null,
      country_code: row["country code"] ?? null,
      key: row.key ?? id,
    });
  }
  if (fromTable.length) return fromTable;

  const out: MetaTargetingOption[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(
      /[-*]\s*(.+?)\s*(?:\(|·|-)\s*(?:id[:\s]*)?(\d{5,})/i,
    );
    if (m) {
      out.push({
        id: m[2],
        name: m[1].replace(/\*\*/g, "").trim(),
        type: searchType,
      });
      continue;
    }
    const m2 = line.match(/`(\d{5,})`\s*[·:—-]\s*(.+)/);
    if (m2) {
      out.push({ id: m2[1], name: m2[2].trim(), type: searchType });
    }
  }
  return out;
}
