-- Goal-driven strategy: product categories reuse client_services. Margin and
-- average order value drive break-even ROAS; url_patterns attribute spend to a
-- category; source records how the row was created.

alter table public.client_services
  add column if not exists gross_margin_pct numeric
    check (gross_margin_pct between 0 and 100),
  add column if not exists average_order_value_cents integer
    check (average_order_value_cents >= 0),
  add column if not exists url_patterns text[],
  add column if not exists source text
    check (source in ('manual', 'import', 'site_scan'));

-- Not unique: existing rows may already hold duplicates. The API enforces
-- case-insensitive uniqueness per client.
create index if not exists client_services_client_lower_name_idx
  on public.client_services (client_id, lower(name));
