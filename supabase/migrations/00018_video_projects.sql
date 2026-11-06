-- Video ad projects (Creatives > Video): the brief, the three scripts, the confirmed script and,
-- in later steps, the clip plan and the finished video. Drafts and images are untouched. Idempotent.

create table if not exists public.video_projects (
  id text primary key,
  client_id uuid not null references public.clients (id) on delete cascade,
  service_id uuid references public.client_services (id) on delete set null,
  created_by uuid,
  inputs jsonb not null default '{}'::jsonb,
  assets jsonb not null default '[]'::jsonb,
  brand jsonb,
  status text not null default 'writing',
  error text,
  scripts jsonb,
  chosen_script jsonb,
  plan jsonb,
  clips jsonb,
  final jsonb,
  lease_until timestamptz,
  progress jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists video_projects_client_id_idx on public.video_projects (client_id, created_at desc);

drop trigger if exists video_projects_set_updated_at on public.video_projects;
create trigger video_projects_set_updated_at
before update on public.video_projects
for each row execute function public.set_updated_at();

alter table public.video_projects enable row level security;

drop policy if exists video_projects_select on public.video_projects;
create policy video_projects_select
  on public.video_projects for select to authenticated
  using (public.has_client_access(client_id));

drop policy if exists video_projects_insert on public.video_projects;
create policy video_projects_insert
  on public.video_projects for insert to authenticated
  with check (public.has_client_access(client_id));

drop policy if exists video_projects_update on public.video_projects;
create policy video_projects_update
  on public.video_projects for update to authenticated
  using (public.has_client_access(client_id));

-- Added after the first version of this migration; safe to run again.
alter table public.video_projects add column if not exists progress jsonb;
