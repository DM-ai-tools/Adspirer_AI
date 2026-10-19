import { beforeEach, describe, expect, it, vi } from "vitest";

// The Supabase path of applyCategoryImport, against a fake client that records
// how many rows each insert carries and how many ids each `.in("id", …)` filter
// puts in the request URL.
const calls = vi.hoisted(() => ({
  existing: [] as Array<{ id: string; name: string }>,
  insertSizes: [] as number[],
  inSizes: [] as number[],
}));

vi.mock("@/lib/config", () => ({
  getConfig: () => ({ isDemoMode: false, hasSupabase: true }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({ eq: async () => ({ data: calls.existing, error: null }) }),
      insert: async (rows: unknown[]) => {
        calls.insertSizes.push(rows.length);
        return { error: null };
      },
      update: () => ({
        in: async (_column: string, ids: string[]) => {
          calls.inSizes.push(ids.length);
          return { error: null };
        },
      }),
    }),
  }),
}));

import { ID_FILTER_CHUNK, applyCategoryImport, type CategoryImportRow } from "@/lib/clients/category-import";

const row = (name: string): CategoryImportRow => ({
  name,
  landing_page_url: null,
  gross_margin_pct: null,
  average_order_value_cents: null,
  priority: null,
});

const names = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`);

beforeEach(() => {
  calls.existing = [];
  calls.insertSizes = [];
  calls.inSizes = [];
});

describe("applyCategoryImport on Supabase", () => {
  it("keeps every id filter short enough for the request URL", () => {
    expect(ID_FILTER_CHUNK).toBeLessThanOrEqual(100);
  });

  it("splits a large same-patch update into short id filters", async () => {
    // A name-only re-import: every row gets the same patch, so all 1000 ids
    // fall into one update group.
    calls.existing = names(1000, "Cat").map((name, i) => ({ id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`, name }));
    const result = await applyCategoryImport("c1", names(1000, "Cat").map(row), "merge", []);

    expect(result).toEqual({ created: 0, updated: 1000 });
    expect(calls.inSizes.reduce((a, b) => a + b, 0)).toBe(1000);
    expect(Math.max(...calls.inSizes)).toBeLessThanOrEqual(ID_FILTER_CHUNK);
  });

  it("splits replace-mode deactivation into short id filters", async () => {
    calls.existing = names(250, "Old").map((name, i) => ({ id: `id-${i}`, name }));
    const result = await applyCategoryImport("c1", [row("New one")], "replace", []);

    expect(result).toEqual({ created: 1, updated: 0 });
    expect(calls.inSizes.reduce((a, b) => a + b, 0)).toBe(250);
    expect(Math.max(...calls.inSizes)).toBeLessThanOrEqual(ID_FILTER_CHUNK);
  });

  it("still inserts new rows in large batches", async () => {
    await applyCategoryImport("c1", names(1000, "New").map(row), "merge", []);
    expect(calls.insertSizes).toEqual([500, 500]);
  });
});
