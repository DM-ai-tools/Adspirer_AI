-- Agent learning: feedback + durable learnings for self-improving workspace

create table if not exists public.agent_feedback (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  conversation_id uuid references public.conversations (id) on delete set null,
  message_id uuid references public.messages (id) on delete set null,
  task_id uuid references public.tasks (id) on delete set null,
  user_id uuid not null references public.profiles (id) on delete cascade,
  rating text not null check (rating in ('up', 'down')),
  comment text,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists agent_feedback_client_id_idx
  on public.agent_feedback (client_id);
create index if not exists agent_feedback_created_at_idx
  on public.agent_feedback (created_at);

create table if not exists public.agent_learnings (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  source text not null default 'system',
  insight text not null,
  evidence jsonb,
  weight numeric not null default 1,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists agent_learnings_client_id_idx
  on public.agent_learnings (client_id);
create index if not exists agent_learnings_created_at_idx
  on public.agent_learnings (created_at);

create trigger agent_learnings_set_updated_at
before update on public.agent_learnings
for each row execute function public.set_updated_at();

alter table public.agent_feedback enable row level security;
alter table public.agent_learnings enable row level security;

create policy agent_feedback_select
  on public.agent_feedback for select to authenticated
  using (public.is_admin() or public.has_client_access(client_id));

create policy agent_feedback_insert
  on public.agent_feedback for insert to authenticated
  with check (public.has_client_access(client_id) and user_id = auth.uid());

create policy agent_learnings_select
  on public.agent_learnings for select to authenticated
  using (public.is_admin() or public.has_client_access(client_id));

create policy agent_learnings_insert
  on public.agent_learnings for insert to authenticated
  with check (public.is_admin() or public.has_client_access(client_id));

create policy agent_learnings_update
  on public.agent_learnings for update to authenticated
  using (public.is_admin() or public.has_client_access(client_id));

grant select, insert on public.agent_feedback to authenticated;
grant select, insert, update on public.agent_learnings to authenticated;
grant all on public.agent_feedback to service_role;
grant all on public.agent_learnings to service_role;
