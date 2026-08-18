-- Creative drafts for the unified Workspace <-> Creatives workflow.
-- Draft ids are application-generated (crd_*), so the primary key is text
-- while all foreign keys match the uuid columns from 00001_foundation.sql.

create table if not exists public.creative_drafts (
  id text primary key,
  client_id uuid not null references public.clients (id) on delete cascade,
  service_id uuid references public.client_services (id) on delete set null,
  conversation_id uuid references public.conversations (id) on delete set null,
  task_id uuid references public.tasks (id) on delete set null,
  brief_id uuid references public.competitor_briefs (id) on delete set null,
  concept text not null,
  headline text not null,
  primary_text text not null,
  description text,
  cta text,
  creative_direction text,
  image_url text,
  image_b64 text,
  image_mime text not null default 'image/png',
  image_model text,
  image_prompt text,
  image_status text not null default 'pending',
  image_error text,
  landing_page_url text,
  brand_colors jsonb,
  logo_url text,
  status text not null default 'draft',
  revision_notes text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists creative_drafts_client_id_idx on public.creative_drafts (client_id);
create index if not exists creative_drafts_conversation_id_idx on public.creative_drafts (conversation_id);
create index if not exists creative_drafts_task_id_idx on public.creative_drafts (task_id);
create index if not exists creative_drafts_status_idx on public.creative_drafts (status);
create index if not exists creative_drafts_updated_at_idx on public.creative_drafts (updated_at desc);

drop trigger if exists creative_drafts_set_updated_at on public.creative_drafts;
create trigger creative_drafts_set_updated_at
before update on public.creative_drafts
for each row execute function public.set_updated_at();

alter table public.creative_drafts enable row level security;

drop policy if exists creative_drafts_select on public.creative_drafts;
create policy creative_drafts_select
  on public.creative_drafts for select to authenticated
  using (public.has_client_access(client_id));

drop policy if exists creative_drafts_insert on public.creative_drafts;
create policy creative_drafts_insert
  on public.creative_drafts for insert to authenticated
  with check (public.has_client_access(client_id));

drop policy if exists creative_drafts_update on public.creative_drafts;
create policy creative_drafts_update
  on public.creative_drafts for update to authenticated
  using (public.has_client_access(client_id));

drop policy if exists creative_drafts_delete on public.creative_drafts;
create policy creative_drafts_delete
  on public.creative_drafts for delete to authenticated
  using (public.is_admin());

grant select, insert, update, delete on public.creative_drafts to authenticated;
