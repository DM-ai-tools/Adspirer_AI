-- Per-variant sales (last 30 and 60 days) synced from Shopify orders. The product title,
-- variant title, SKU, vendor and product type come from the order lines, so no catalogue
-- is needed. variant_key is the variant gid, or, when the variant was deleted,
-- product:<product gid>:<sku>, else product:<product gid>:<product title> / <variant title>,
-- else product:<product gid>:<product title>. synced_run marks the sync that last wrote a
-- row. No customer personal data. Idempotent.

create table if not exists public.shopify_sales (
  client_id uuid not null references public.clients(id) on delete cascade,
  variant_key text not null,
  variant_gid text,
  product_gid text,
  product_title text not null,
  variant_title text,
  sku text,
  vendor text not null default '',
  product_type text not null default '',
  units_30d integer not null default 0,
  revenue_30d_cents bigint not null default 0,
  units_60d integer not null default 0,
  revenue_60d_cents bigint not null default 0,
  synced_run uuid not null,
  updated_at timestamptz not null default now(),
  primary key (client_id, variant_key)
);

alter table public.shopify_sales enable row level security;

drop policy if exists shopify_sales_select on public.shopify_sales;
create policy shopify_sales_select
  on public.shopify_sales for select to authenticated
  using (public.has_client_access(client_id));

-- Writes come from the sync (service role) only: drop any default grants first, then give
-- signed-in users read access (rows limited by the policy) and the service role everything.
revoke all on public.shopify_sales from anon, authenticated;
grant select on public.shopify_sales to authenticated;
grant all on public.shopify_sales to service_role;
