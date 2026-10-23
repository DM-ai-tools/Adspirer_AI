-- Read-only Shopify connection (one store per client) and its synced catalogue.
-- The connection row holds the encrypted access token (service role only). The data
-- tables are rewritten by each sync; synced_run marks the sync that last wrote a row so
-- rows missing from the latest run can be dropped. No customer personal data. Idempotent.

create table if not exists public.shopify_connection (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null unique references public.clients(id) on delete cascade,
  shop_domain text not null,
  shop_name text,
  currency text,
  access_token_encrypted text not null,
  scopes text[] not null default '{}',
  connected_by uuid references public.profiles(id) on delete set null,
  connected_at timestamptz not null default now(),
  last_sync_at timestamptz,
  last_sync_status text not null default 'never'
    check (last_sync_status in ('never', 'running', 'ok', 'error')),
  last_sync_error text,
  last_sync_counts jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.shopify_connection enable row level security;

-- The token is server-side only: no policy and no grants for anon or authenticated.
revoke all on public.shopify_connection from anon, authenticated;
grant all on public.shopify_connection to service_role;

drop trigger if exists shopify_connection_set_updated_at on public.shopify_connection;
create trigger shopify_connection_set_updated_at
before update on public.shopify_connection
for each row execute function public.set_updated_at();

create table if not exists public.shopify_collections (
  client_id uuid not null references public.clients(id) on delete cascade,
  gid text not null,
  handle text not null,
  title text not null,
  products_count integer not null default 0,
  synced_run uuid not null,
  updated_at timestamptz not null default now(),
  primary key (client_id, gid)
);

create table if not exists public.shopify_products (
  client_id uuid not null references public.clients(id) on delete cascade,
  gid text not null,
  title text not null,
  handle text not null,
  vendor text not null default '',
  product_type text not null default '',
  status text not null check (status in ('ACTIVE', 'DRAFT', 'ARCHIVED', 'UNLISTED', 'UNKNOWN')),
  collection_gids text[] not null default '{}',
  synced_run uuid not null,
  updated_at timestamptz not null default now(),
  primary key (client_id, gid)
);

create table if not exists public.shopify_variants (
  client_id uuid not null references public.clients(id) on delete cascade,
  gid text not null,
  product_gid text not null,
  title text not null,
  sku text,
  price_cents bigint not null default 0,
  cost_cents bigint,
  inventory_quantity integer,
  units_30d integer not null default 0,
  revenue_30d_cents bigint not null default 0,
  units_60d integer not null default 0,
  revenue_60d_cents bigint not null default 0,
  synced_run uuid not null,
  updated_at timestamptz not null default now(),
  primary key (client_id, gid)
);

create index if not exists shopify_variants_client_product_idx
  on public.shopify_variants (client_id, product_gid);

alter table public.shopify_collections enable row level security;
alter table public.shopify_products enable row level security;
alter table public.shopify_variants enable row level security;

drop policy if exists shopify_collections_select on public.shopify_collections;
create policy shopify_collections_select
  on public.shopify_collections for select to authenticated
  using (public.has_client_access(client_id));

drop policy if exists shopify_products_select on public.shopify_products;
create policy shopify_products_select
  on public.shopify_products for select to authenticated
  using (public.has_client_access(client_id));

drop policy if exists shopify_variants_select on public.shopify_variants;
create policy shopify_variants_select
  on public.shopify_variants for select to authenticated
  using (public.has_client_access(client_id));

-- Writes come from the sync (service role) only.
grant select on public.shopify_collections to authenticated;
grant select on public.shopify_products to authenticated;
grant select on public.shopify_variants to authenticated;
grant all on public.shopify_collections to service_role;
grant all on public.shopify_products to service_role;
grant all on public.shopify_variants to service_role;
