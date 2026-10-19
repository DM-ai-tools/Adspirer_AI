import * as XLSX from "xlsx";
import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { nowIso } from "@/lib/utils";
import type { ClientService } from "@/types";

export type CategoryImportRow = {
  name: string;
  landing_page_url: string | null;
  gross_margin_pct: number | null;
  average_order_value_cents: number | null;
  priority: number;
};

export const MAX_IMPORT_ROWS = 1000;

type Field = "name" | "url" | "margin" | "aov" | "priority";

const ALIASES: Record<Field, string[]> = {
  name: ["category", "productline", "collection", "name", "service"],
  url: ["landingpage", "url", "link", "landingpageurl"],
  margin: ["grossmargin", "margin", "grossmarginpct"],
  aov: ["aov", "averageordervalue", "avgordervalue"],
  priority: ["priority"],
};

// "Gross Margin %" -> "grossmargin"; "landing_page_url" -> "landingpageurl"
const headerKey = (h: unknown) => String(h ?? "").toLowerCase().replace(/[^a-z]/g, "");

function toNumber(raw: unknown): { value: number | null; percent: boolean } {
  if (typeof raw === "number") {
    return { value: Number.isFinite(raw) ? raw : null, percent: false };
  }
  const s = String(raw ?? "").trim();
  const digits = s.replace(/[^0-9.\-]/g, "");
  const n = Number(digits);
  return {
    value: digits && Number.isFinite(n) ? n : null,
    percent: s.includes("%"),
  };
}

export function parseCategorySheet(
  data: ArrayBuffer,
  fileName: string,
): { rows: CategoryImportRow[]; errors: string[] } {
  const errors: string[] = [];
  let aoa: unknown[][];
  try {
    const workbook = XLSX.read(data, { type: "array" });
    const sheet = workbook.Sheets[workbook.SheetNames[0] ?? ""];
    aoa = sheet
      ? XLSX.utils.sheet_to_json<unknown[]>(sheet, {
          header: 1,
          defval: "",
          blankrows: false,
        })
      : [];
  } catch {
    return { rows: [], errors: [`Could not read ${fileName} as a spreadsheet.`] };
  }

  const header = aoa[0] ?? [];
  const col: Partial<Record<Field, number>> = {};
  header.forEach((h, i) => {
    const key = headerKey(h);
    for (const f of Object.keys(ALIASES) as Field[]) {
      if (col[f] === undefined && ALIASES[f].includes(key)) col[f] = i;
    }
  });
  if (col.name === undefined) {
    return {
      rows: [],
      errors: [
        "No category name column found. Accepted headers: Category, Product line, Collection, Name, Service.",
      ],
    };
  }

  const rows: CategoryImportRow[] = [];
  const seen = new Map<string, string>();
  const body = aoa.slice(1);
  for (let i = 0; i < body.length; i++) {
    const line = body[i];
    const rowNo = i + 2;
    const name = String(line[col.name] ?? "").trim();
    if (!name) continue;
    if (rows.length >= MAX_IMPORT_ROWS) {
      errors.push(
        `Only the first ${MAX_IMPORT_ROWS} rows were imported; the rest were ignored.`,
      );
      break;
    }
    const key = name.toLowerCase();
    const first = seen.get(key);
    if (first !== undefined) {
      errors.push(`Row ${rowNo}: duplicate category "${first}" skipped (first row kept).`);
      continue;
    }
    seen.set(key, name);

    let margin: number | null = null;
    if (col.margin !== undefined) {
      const { value, percent } = toNumber(line[col.margin]);
      if (value !== null) {
        // 1 or less is a fraction (0.35 -> 35), unless written with a % sign
        const pct = !percent && value <= 1 ? value * 100 : value;
        const rounded = Math.round(pct * 100) / 100;
        if (rounded < 0 || rounded > 100) {
          errors.push(`Row ${rowNo}: margin for "${name}" must be between 0 and 100, ignored.`);
        } else {
          margin = rounded;
        }
      }
    }
    let aov: number | null = null;
    if (col.aov !== undefined) {
      const { value } = toNumber(line[col.aov]);
      if (value !== null) {
        if (value < 0) {
          errors.push(`Row ${rowNo}: AOV for "${name}" must not be negative, ignored.`);
        } else {
          aov = Math.round(value * 100);
        }
      }
    }
    let priority = 0;
    if (col.priority !== undefined) {
      const { value } = toNumber(line[col.priority]);
      if (value !== null) priority = Math.round(value);
    }
    const url = col.url !== undefined ? String(line[col.url] ?? "").trim() : "";

    rows.push({
      name,
      landing_page_url: url || null,
      gross_margin_pct: margin,
      average_order_value_cents: aov,
      priority,
    });
  }
  return { rows, errors };
}

export type CategoryImportMode = "merge" | "replace";

/**
 * Writes parsed rows for a client (demo store or Supabase). Existing rows are
 * matched by trimmed, case-insensitive name and updated instead of duplicated.
 * `replace` deactivates categories missing from the file; it never deletes.
 */
export async function applyCategoryImport(
  clientId: string,
  rows: CategoryImportRow[],
  mode: CategoryImportMode,
): Promise<{ created: number; updated: number }> {
  const config = getConfig();
  const demo = config.isDemoMode || !config.hasSupabase;
  const norm = (s: string) => s.trim().toLowerCase();
  const ts = nowIso();
  const fileNames = new Set(rows.map((r) => norm(r.name)));
  let created = 0;
  let updated = 0;

  const fields = (r: CategoryImportRow) => ({
    landing_page_url: r.landing_page_url,
    gross_margin_pct: r.gross_margin_pct,
    average_order_value_cents: r.average_order_value_cents,
    priority: r.priority,
    is_active: true,
    source: "import" as const,
    updated_at: ts,
  });

  if (demo) {
    const store = getDemoStore();
    const existing = store.clientServices.filter((s) => s.client_id === clientId);
    for (const r of rows) {
      const hit = existing.find((s) => norm(s.name) === norm(r.name));
      if (hit) {
        Object.assign(hit, fields(r));
        updated++;
      } else {
        const svc: ClientService = {
          id: crypto.randomUUID(),
          client_id: clientId,
          name: r.name,
          description: null,
          keywords: null,
          url_patterns: null,
          created_at: ts,
          ...fields(r),
        };
        store.clientServices.push(svc);
        created++;
      }
    }
    if (mode === "replace") {
      for (const s of existing) {
        if (!fileNames.has(norm(s.name))) {
          s.is_active = false;
          s.updated_at = ts;
        }
      }
    }
    return { created, updated };
  }

  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("client_services")
    .select("id, name")
    .eq("client_id", clientId);
  if (error) throw new Error(error.message);
  const existing = (data ?? []) as Array<{ id: string; name: string }>;

  for (const r of rows) {
    const hit = existing.find((s) => norm(s.name) === norm(r.name));
    if (hit) {
      const { error: e } = await supabase
        .from("client_services")
        .update(fields(r))
        .eq("id", hit.id);
      if (e) throw new Error(e.message);
      updated++;
    } else {
      const { error: e } = await supabase
        .from("client_services")
        .insert({ client_id: clientId, name: r.name, created_at: ts, ...fields(r) });
      if (e) throw new Error(e.message);
      created++;
    }
  }
  if (mode === "replace") {
    const drop = existing
      .filter((s) => !fileNames.has(norm(s.name)))
      .map((s) => s.id);
    if (drop.length) {
      const { error: e } = await supabase
        .from("client_services")
        .update({ is_active: false, updated_at: ts })
        .in("id", drop);
      if (e) throw new Error(e.message);
    }
  }
  return { created, updated };
}
