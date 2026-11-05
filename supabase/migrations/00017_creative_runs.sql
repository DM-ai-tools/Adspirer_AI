-- Bulk creative runs: one run makes 15 hook-led ads over a few reused bodies. The run holds the
-- plan (message map, bodies, CTAs) and which draft carries which angle. Drafts stay in
-- creative_drafts, unchanged. Idempotent.

create table if not exists public.creative_runs (
  id text primary key,
  client_id uuid not null references public.clients (id) on delete cascade,
  service_id uuid references public.client_services (id) on delete set null,
  created_by uuid,
  landing_page_url text,
  inputs jsonb not null default '{}'::jsonb,
  image_format text not null default '4:5',
  status text not null default 'planning',
  error text,
  message_map jsonb,
  bodies jsonb,
  ctas jsonb,
  items jsonb not null default '[]'::jsonb,
  lease_until timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists creative_runs_client_id_idx on public.creative_runs (client_id, created_at desc);

drop trigger if exists creative_runs_set_updated_at on public.creative_runs;
create trigger creative_runs_set_updated_at
before update on public.creative_runs
for each row execute function public.set_updated_at();

alter table public.creative_runs enable row level security;

drop policy if exists creative_runs_select on public.creative_runs;
create policy creative_runs_select
  on public.creative_runs for select to authenticated
  using (public.has_client_access(client_id));

drop policy if exists creative_runs_insert on public.creative_runs;
create policy creative_runs_insert
  on public.creative_runs for insert to authenticated
  with check (public.has_client_access(client_id));

drop policy if exists creative_runs_update on public.creative_runs;
create policy creative_runs_update
  on public.creative_runs for update to authenticated
  using (public.has_client_access(client_id));
