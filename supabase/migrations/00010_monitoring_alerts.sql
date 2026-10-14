-- Phase 4: scheduled monitoring alerts with de-duplication, acknowledge and
-- snooze. One row per client and alert key (what + which entity); the
-- scheduled job writes with the service role, people read their clients'.

create table if not exists public.monitoring_alerts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  key text not null,
  severity text not null check (severity in ('critical', 'warning')),
  title text,
  detail text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  notified_at timestamptz,
  acknowledged_at timestamptz,
  acknowledged_by uuid references public.profiles(id) on delete set null,
  snoozed_until timestamptz,
  resolved_at timestamptz,
  approval_id uuid references public.approvals(id) on delete set null,
  unique (client_id, key)
);

create index if not exists idx_monitoring_alerts_open
  on public.monitoring_alerts(client_id, last_seen_at desc)
  where resolved_at is null;

alter table public.monitoring_alerts enable row level security;

drop policy if exists monitoring_alerts_select on public.monitoring_alerts;
create policy monitoring_alerts_select on public.monitoring_alerts
  for select to authenticated
  using (public.has_client_access(client_id));

grant select on public.monitoring_alerts to authenticated;
