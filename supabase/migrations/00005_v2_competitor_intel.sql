-- V2 competitor intelligence persistence for uploaded sheets and crawl snapshots.

create table if not exists public.v2_competitor_upload_batches (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  uploaded_by uuid references public.profiles(id) on delete set null,
  filename text,
  total_rows integer not null default 0,
  inserted_rows integer not null default 0,
  updated_rows integer not null default 0,
  raw_metadata jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.v2_competitor_ad_snapshots (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  competitor_id uuid references public.competitors(id) on delete set null,
  provider text not null default 'sociavault',
  ad_archive_id text not null,
  page_id text,
  page_name text,
  media_type text,
  headline text,
  body text,
  cta text,
  landing_url text,
  image_url text,
  video_url text,
  publisher_platform jsonb,
  is_active boolean not null default true,
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  raw jsonb,
  created_at timestamptz not null default now(),
  unique (client_id, ad_archive_id)
);

create index if not exists idx_v2_competitor_ad_snapshots_client
  on public.v2_competitor_ad_snapshots(client_id, created_at desc);

alter table public.v2_competitor_upload_batches enable row level security;
alter table public.v2_competitor_ad_snapshots enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'v2_competitor_upload_batches'
      and policyname = 'v2_competitor_upload_batches_service_role_all'
  ) then
    create policy v2_competitor_upload_batches_service_role_all
      on public.v2_competitor_upload_batches
      for all
      to service_role
      using (true)
      with check (true);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'v2_competitor_ad_snapshots'
      and policyname = 'v2_competitor_ad_snapshots_service_role_all'
  ) then
    create policy v2_competitor_ad_snapshots_service_role_all
      on public.v2_competitor_ad_snapshots
      for all
      to service_role
      using (true)
      with check (true);
  end if;
end $$;

