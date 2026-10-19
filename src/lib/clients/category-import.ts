import * as XLSX from "xlsx";
import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { nowIso } from "@/lib/utils";
import { marginPctFromNumber } from "@/lib/clients/category-form";
import type { ClientService } from "@/types";

export type CategoryImportRow = {
  name: string;
  landing_page_url: string | null;
  gross_margin_pct: number | null;
  average_order_value_cents: number | null;
  /** null when the cell was blank: a merge leaves the stored priority alone. */
  priority: number | null;
};

export const MAX_IMPORT_ROWS = 1000;
/** Rows per Supabase insert / update call. */
const WRITE_CHUNK = 500;

/** Optional columns that were present in the file's header row. */
export type ImportColumn = "url" | "margin" | "aov" | "priority";
const ALL_COLUMNS: ImportColumn[] = ["url", "margin", "aov", "priority"];

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
): {
  rows: CategoryImportRow[];
  errors: string[];
  columns: ImportColumn[];
  /** True when rows past MAX_IMPORT_ROWS were dropped. */
  truncated: boolean;
} {
  const errors: string[] = [];
  let truncated = false;
  let aoa: unknown[][];
  try {
    // CSV is read as UTF-8 text (BOM stripped); as bytes, XLSX would decode it as Latin-1.
    const workbook = /\.csv$/i.test(fileName)
      ? XLSX.read(new TextDecoder("utf-8").decode(data).replace(/^\uFEFF/, ""), { type: "string" })
      : XLSX.read(data, { type: "array" });
    const sheet = workbook.Sheets[workbook.SheetNames[0] ?? ""];
    aoa = sheet
      ? XLSX.utils.sheet_to_json<unknown[]>(sheet, {
          header: 1,
          defval: "",
          blankrows: false,
        })
      : [];
  } catch {
    return { rows: [], errors: [`Could not read ${fileName} as a spreadsheet.`], columns: [], truncated };
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
      columns: [],
      truncated,
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
      truncated = true;
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
        const rounded = marginPctFromNumber(value, percent);
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
    let priority: number | null = null;
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
  const columns = ALL_COLUMNS.filter((c) => col[c] !== undefined);
  return { rows, errors, columns, truncated };
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
  columns: ImportColumn[] = ALL_COLUMNS,
): Promise<{ created: number; updated: number }> {
  const config = getConfig();
  const demo = config.isDemoMode || !config.hasSupabase;
  const norm = (s: string) => s.trim().toLowerCase();
  const ts = nowIso();
  const fileNames = new Set(rows.map((r) => norm(r.name)));
  let created = 0;
  let updated = 0;

  // New rows get every field.
  const insertFields = (r: CategoryImportRow) => ({
    landing_page_url: r.landing_page_url,
    gross_margin_pct: r.gross_margin_pct,
    average_order_value_cents: r.average_order_value_cents,
    priority: r.priority ?? 0,
    is_active: true,
    source: "import" as const,
    updated_at: ts,
  });
  // Existing rows only change where the file has a column and a non-blank cell,
  // and keep their source. Listing a category in the file reactivates it.
  const updateFields = (r: CategoryImportRow) => ({
    ...(columns.includes("url") && r.landing_page_url !== null
      ? { landing_page_url: r.landing_page_url }
      : {}),
    ...(columns.includes("margin") && r.gross_margin_pct !== null
      ? { gross_margin_pct: r.gross_margin_pct }
      : {}),
    ...(columns.includes("aov") && r.average_order_value_cents !== null
      ? { average_order_value_cents: r.average_order_value_cents }
      : {}),
    ...(columns.includes("priority") && r.priority !== null ? { priority: r.priority } : {}),
    is_active: true,
    updated_at: ts,
  });

  if (demo) {
    const store = getDemoStore();
    const existing = store.clientServices.filter((s) => s.client_id === clientId);
    for (const r of rows) {
      const hit = existing.find((s) => norm(s.name) === norm(r.name));
      if (hit) {
        Object.assign(hit, updateFields(r));
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
          ...insertFields(r),
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

  // Batched: one insert per WRITE_CHUNK new rows, and one update per distinct
  // change set (rows getting the same values share a single `.in("id", …)`).
  const byName = new Map<string, string>();
  for (const s of existing) if (!byName.has(norm(s.name))) byName.set(norm(s.name), s.id);
  const inserts: Array<Record<string, unknown>> = [];
  const updates = new Map<string, { patch: ReturnType<typeof updateFields>; ids: string[] }>();
  for (const r of rows) {
    const id = byName.get(norm(r.name));
    if (id) {
      const patch = updateFields(r);
      const key = JSON.stringify(patch);
      const group = updates.get(key) ?? { patch, ids: [] };
      group.ids.push(id);
      updates.set(key, group);
      updated++;
    } else {
      inserts.push({ client_id: clientId, name: r.name, created_at: ts, ...insertFields(r) });
      created++;
    }
  }
  for (let i = 0; i < inserts.length; i += WRITE_CHUNK) {
    const { error: e } = await supabase.from("client_services").insert(inserts.slice(i, i + WRITE_CHUNK));
    if (e) throw new Error(e.message);
  }
  for (const { patch, ids } of updates.values()) {
    for (let i = 0; i < ids.length; i += WRITE_CHUNK) {
      const { error: e } = await supabase
        .from("client_services")
        .update(patch)
        .in("id", ids.slice(i, i + WRITE_CHUNK));
      if (e) throw new Error(e.message);
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
