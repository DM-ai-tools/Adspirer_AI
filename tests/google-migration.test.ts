import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(path.resolve(__dirname, "../supabase/migrations/00012_google_connections.sql"), "utf8").toLowerCase();

describe("00012_google_connections.sql", () => {
  it("keeps the refresh-token table service-role only: RLS on, no browser policy, no browser grants", () => {
    expect(sql).toContain("alter table public.google_oauth_connection enable row level security;");
    expect(sql).not.toMatch(/create policy [a-z_]+\s+on public\.google_oauth_connection\b/);
    // Dropped if an earlier draft of this migration created it.
    expect(sql).toContain("drop policy if exists google_oauth_connection_admin_all on public.google_oauth_connection;");
    expect(sql).toContain("revoke all on public.google_oauth_connection from anon, authenticated;");
    expect(sql).toContain("grant all on public.google_oauth_connection to service_role;");
  });

  it("grants connected_google_assets like connected_meta_accounts", () => {
    expect(sql).toContain("grant select, insert, update, delete on public.connected_google_assets to authenticated;");
    expect(sql).toContain("grant all on public.connected_google_assets to service_role;");
  });

  it("stays idempotent: every policy is dropped before it is created, every table is if-not-exists", () => {
    for (const [, name, table] of sql.matchAll(/create policy ([a-z_]+)\s+on (public\.[a-z_]+)/g)) {
      expect(sql, name).toContain(`drop policy if exists ${name} on ${table};`);
    }
    expect(sql).not.toMatch(/create table (?!if not exists)/);
    expect(sql).not.toMatch(/create (unique )?index (?!if not exists)/);
  });
});
