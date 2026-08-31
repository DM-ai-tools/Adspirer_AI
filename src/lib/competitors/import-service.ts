import { nanoid } from "nanoid";
import * as XLSX from "xlsx";
import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { nowIso } from "@/lib/utils";
import type { Competitor } from "@/types";

export type ImportedCompetitorRow = {
  name: string;
  website_url: string | null;
  domain: string | null;
  notes: string | null;
};

function normalizeDomain(raw: string | null): string | null {
  if (!raw) return null;
  const withoutProtocol = raw.replace(/^https?:\/\//i, "").trim();
  const host = withoutProtocol.split("/")[0]?.toLowerCase() ?? "";
  return host || null;
}

export function parseCompetitorWorkbook(fileBuffer: ArrayBuffer): ImportedCompetitorRow[] {
  const workbook = XLSX.read(fileBuffer, { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0] ?? ""];
  if (!sheet) return [];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "",
  });
  return rows
    .map((row) => {
      const name = String(
        row.name ?? row.competitor ?? row.company ?? row.brand ?? "",
      ).trim();
      const websiteRaw = String(row.website ?? row.url ?? row.domain ?? "").trim();
      const website = websiteRaw || null;
      const domain = normalizeDomain(
        website ?? (String(row.domain ?? "").trim() || null),
      );
      const notes = String(row.notes ?? row.note ?? "").trim() || null;
      if (!name) return null;
      return {
        name,
        website_url: website,
        domain,
        notes,
      } satisfies ImportedCompetitorRow;
    })
    .filter((row): row is ImportedCompetitorRow => Boolean(row));
}

export async function upsertImportedCompetitors(input: {
  clientId: string;
  rows: ImportedCompetitorRow[];
}): Promise<{ inserted: number; updated: number; total: number }> {
  const config = getConfig();
  const ts = nowIso();
  const deduped = new Map<string, ImportedCompetitorRow>();
  for (const row of input.rows) {
    const key = `${row.name.toLowerCase()}::${row.domain ?? ""}`;
    if (!deduped.has(key)) deduped.set(key, row);
  }
  const normalizedRows = [...deduped.values()];

  if (config.isDemoMode || !config.hasSupabase) {
    const store = getDemoStore();
    let inserted = 0;
    let updated = 0;
    for (const row of normalizedRows) {
      const existing = store.competitors.find(
        (c) =>
          c.client_id === input.clientId &&
          c.name.toLowerCase() === row.name.toLowerCase(),
      );
      if (existing) {
        existing.website_url = row.website_url;
        existing.domain = row.domain;
        existing.notes = row.notes;
        existing.updated_at = ts;
        updated += 1;
      } else {
        store.competitors.push({
          id: `comp_${nanoid(10)}`,
          client_id: input.clientId,
          name: row.name,
          website_url: row.website_url,
          domain: row.domain,
          notes: row.notes,
          created_at: ts,
          updated_at: ts,
        } satisfies Competitor);
        inserted += 1;
      }
    }
    return { inserted, updated, total: normalizedRows.length };
  }

  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();
  const { data: existingRows, error: existingError } = await supabase
    .from("competitors")
    .select("*")
    .eq("client_id", input.clientId);
  if (existingError) throw new Error(existingError.message);

  const existing = existingRows ?? [];
  let inserted = 0;
  let updated = 0;

  for (const row of normalizedRows) {
    const found = existing.find(
      (c) =>
        String(c.name).toLowerCase() === row.name.toLowerCase() ||
        (row.domain && String(c.website ?? "").includes(row.domain)),
    );
    if (found) {
      const { error } = await supabase
        .from("competitors")
        .update({
          website: row.website_url,
          notes: row.notes,
          updated_at: ts,
        })
        .eq("id", found.id);
      if (error) throw new Error(error.message);
      updated += 1;
      continue;
    }
    const { error } = await supabase.from("competitors").insert({
      id: `comp_${nanoid(10)}`,
      client_id: input.clientId,
      name: row.name,
      website: row.website_url,
      notes: row.notes,
      created_at: ts,
      updated_at: ts,
    });
    if (error) throw new Error(error.message);
    inserted += 1;
  }

  return { inserted, updated, total: normalizedRows.length };
}

