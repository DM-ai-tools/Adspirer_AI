-- Read-only Google connections (GA4, Google Ads, Search Console).
-- One org-level OAuth connection (service role only) and the Google assets it can see,
-- each optionally mapped to a client. Idempotent.

create table if not exists public.google_oauth_connection (
  id uuid primary key default gen_random_uuid(),
  google_email text,
  scopes text[] not null default '{}',
  refresh_token_encrypted text not null,
  connected_by uuid references public.profiles(id) on delete set null,
  connected_at timestamptz not null default now(),
  last_refreshed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.google_oauth_connection enable row level security;

-- The refresh token is server-side only: no policy for anon or authenticated (not even
-- admins in the browser) and no grants, so only the service_role (bypasses RLS) reads it.
-- Same as adspirer_service_account in 00001.
drop policy if exists google_oauth_connection_admin_all on public.google_oauth_connection;
revoke all on public.google_oauth_connection from anon, authenticated;
grant all on public.google_oauth_connection to service_role;

drop trigger if exists google_oauth_connection_set_updated_at on public.google_oauth_connection;
create trigger google_oauth_connection_set_updated_at
before update on public.google_oauth_connection
for each row execute function public.set_updated_at();

create table if not exists public.connected_google_assets (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('ga4_property', 'ads_customer', 'gsc_site')),
  external_id text not null,
  name text not null,
  parent_name text,
  currency text,
  timezone text,
  login_customer_id text,
  mapped_client_id uuid references public.clients(id) on delete set null,
  raw_metadata jsonb,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (kind, external_id)
);

create unique index if not exists connected_google_assets_one_per_client
  on public.connected_google_assets (kind, mapped_client_id)
  where mapped_client_id is not null;

create index if not exists connected_google_assets_mapped_client_id_idx
  on public.connected_google_assets (mapped_client_id);

alter table public.connected_google_assets enable row level security;

drop policy if exists connected_google_assets_select on public.connected_google_assets;
create policy connected_google_assets_select
  on public.connected_google_assets for select to authenticated
  using (
    public.is_admin()
    or (
      mapped_client_id is not null
      and public.has_client_access(mapped_client_id)
    )
  );

drop policy if exists connected_google_assets_admin_write on public.connected_google_assets;
create policy connected_google_assets_admin_write
  on public.connected_google_assets for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

grant select, insert, update, delete on public.connected_google_assets to authenticated;
grant all on public.connected_google_assets to service_role;

drop trigger if exists connected_google_assets_set_updated_at on public.connected_google_assets;
create trigger connected_google_assets_set_updated_at
before update on public.connected_google_assets
for each row execute function public.set_updated_at();
