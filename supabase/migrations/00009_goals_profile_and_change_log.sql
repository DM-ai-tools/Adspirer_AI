-- Phase 2: client goals & guardrails profile.
-- Targets and limits every decision rule and approval reads
-- (see src/lib/clients/goals.ts). Writes stay admin-only through the
-- existing clients RLS policies.

alter table public.clients
  add column if not exists goals_profile jsonb not null default '{}'::jsonb;

alter table public.clients
  drop constraint if exists clients_goals_profile_is_object;
alter table public.clients
  add constraint clients_goals_profile_is_object
  check (jsonb_typeof(goals_profile) = 'object');

-- Phase 2: why an approval got its risk level (risk_level already exists).
alter table public.approvals
  add column if not exists risk_reason text;

-- Phase 2: append-only log of executed Meta changes (before/after, who
-- approved, who ran it, why). A rollback is a new row pointing at the row
-- it undoes. Same append-only RLS shape as tool_calls: no update/delete.
create table if not exists public.change_log (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  approval_id uuid references public.approvals(id) on delete set null,
  tool_name text not null,
  account_id text,
  entity_type text not null check (entity_type in ('campaign', 'adset', 'ad')),
  entity_id text,
  before jsonb,
  after jsonb,
  approved_by uuid references public.profiles(id) on delete set null,
  executed_by uuid references public.profiles(id) on delete set null,
  rationale text,
  rollback_of uuid references public.change_log(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_change_log_client
  on public.change_log(client_id, created_at desc);

alter table public.change_log enable row level security;

drop policy if exists change_log_select on public.change_log;
create policy change_log_select on public.change_log
  for select to authenticated
  using (public.has_client_access(client_id));

-- Read-only for signed-in users: only the server (service role) writes it,
-- so nobody can forge entries or pre-mark a change as rolled back.
grant select on public.change_log to authenticated;

-- Approvals: every write goes through the server (service role). Signed-in
-- users writing rows directly through the public API could set their own
-- risk level, status or approver and bypass the admin-only rule for
-- high-risk changes, so they keep read access only.
revoke insert, update, delete on public.approvals from authenticated;
