import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(path.resolve(__dirname, "../supabase/migrations/00013_shopify_connection.sql"), "utf8").toLowerCase();

const TABLES = ["shopify_connection", "shopify_collections", "shopify_products", "shopify_variants"];
const DATA_TABLES = TABLES.slice(1);

describe("00013_shopify_connection.sql", () => {
  it("creates every table idempotently", () => {
    for (const t of TABLES) expect(sql).toContain(`create table if not exists public.${t} (`);
    expect(sql).not.toMatch(/create table (?!if not exists)/);
    expect(sql).not.toMatch(/create (unique )?index (?!if not exists)/);
  });

  it("keeps the token table service-role only: no browser grants, no select policy", () => {
    expect(sql).toContain("revoke all on public.shopify_connection from anon, authenticated;");
    expect(sql).toContain("grant all on public.shopify_connection to service_role;");
    expect(sql).not.toMatch(/create policy [a-z_]+\s+on public\.shopify_connection\b/);
    expect(sql).toMatch(/client_id uuid not null unique references public\.clients\(id\) on delete cascade/);
  });

  it("gives the data tables a client-access select policy", () => {
    for (const t of DATA_TABLES) {
      const m = sql.match(new RegExp(String.raw`create policy ${t}_select\s+on public\.${t} for select to authenticated\s+using \(public\.has_client_access\(client_id\)\);`));
      expect(m, t).not.toBeNull();
      expect(sql).toContain(`drop policy if exists ${t}_select on public.${t};`);
      expect(sql).toContain(`grant select on public.${t} to authenticated;`);
      expect(sql).toContain(`grant all on public.${t} to service_role;`);
      expect(sql).toContain("primary key (client_id, gid)");
    }
    expect(sql.match(/synced_run uuid not null/g)?.length).toBe(3);
    expect(sql).toContain("collection_gids text[] not null default '{}'");
    expect(sql).toContain("on public.shopify_variants (client_id, product_gid)");
  });

  it("stores no customer personal data columns", () => {
    expect(sql).not.toMatch(/\b[a-z_]*(email|phone|address|customer)[a-z_]*\s+(text|uuid|jsonb|integer|bigint|numeric)/);
  });
});
