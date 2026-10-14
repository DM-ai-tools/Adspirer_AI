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
