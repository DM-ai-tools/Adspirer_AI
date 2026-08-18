-- =============================================================================
-- Adspirer AI — Foundation schema (00001)
-- Supabase Postgres: enums, tables, indexes, updated_at triggers, RLS helpers
-- =============================================================================

create extension if not exists "pgcrypto";

-- -----------------------------------------------------------------------------
-- Enums (idempotent — safe to re-run after a partial failure)
-- -----------------------------------------------------------------------------

do $$ begin create type public.user_role as enum ('admin', 'operator'); exception when duplicate_object then null; end $$;

do $$ begin create type public.access_method as enum (
  'business_manager_partner',
  'direct_grant'
); exception when duplicate_object then null; end $$;

do $$ begin create type public.access_status as enum (
  'not_requested',
  'requested',
  'granted',
  'stale',
  'revoked'
); exception when duplicate_object then null; end $$;

do $$ begin create type public.task_status as enum (
  'queued',
  'running',
  'waiting_approval',
  'paused',
  'done',
  'error',
  'cancelled'
); exception when duplicate_object then null; end $$;

do $$ begin create type public.message_role as enum (
  'user',
  'assistant',
  'system',
  'tool'
); exception when duplicate_object then null; end $$;

do $$ begin create type public.tool_safety_class as enum (
  'diagnose',
  'execute',
  'blocked'
); exception when duplicate_object then null; end $$;

do $$ begin create type public.tool_call_status as enum (
  'started',
  'succeeded',
  'failed',
  'awaiting_approval',
  'cancelled'
); exception when duplicate_object then null; end $$;

do $$ begin create type public.approval_status as enum (
  'pending',
  'approved',
  'rejected',
  'edited',
  'executing',
  'executed',
  'failed',
  'cancelled'
); exception when duplicate_object then null; end $$;

do $$ begin create type public.approval_risk_level as enum (
  'low',
  'medium',
  'high',
  'critical'
); exception when duplicate_object then null; end $$;

do $$ begin create type public.service_connection_status as enum (
  'disconnected',
  'connected',
  'expired',
  'error'
); exception when duplicate_object then null; end $$;

do $$ begin create type public.meta_account_status as enum (
  'active',
  'disabled',
  'unknown'
); exception when duplicate_object then null; end $$;

do $$ begin create type public.access_request_sent_via as enum (
  'gmail',
  'manual',
  'none'
); exception when duplicate_object then null; end $$;

do $$ begin create type public.competitor_brief_status as enum (
  'pending',
  'ready',
  'failed'
); exception when duplicate_object then null; end $$;

do $$ begin create type public.recommendation_status as enum (
  'open',
  'accepted',
  'dismissed',
  'expired'
); exception when duplicate_object then null; end $$;

do $$ begin create type public.notification_type as enum (
  'approval_pending',
  'approval_executed',
  'task_error',
  'access_stale',
  'monitoring_alert',
  'system'
); exception when duplicate_object then null; end $$;

-- -----------------------------------------------------------------------------
-- updated_at helper
-- -----------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- profiles
-- -----------------------------------------------------------------------------
-- NOTE: Authz helpers (is_admin / has_client_access) are created AFTER
-- profiles + user_client_access — Postgres validates SQL function bodies at
-- CREATE time, so those tables must exist first.


create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null unique,
  full_name text,
  role public.user_role not null default 'operator',
  avatar_url text,
  is_active boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index profiles_role_idx on public.profiles (role);
create index profiles_created_at_idx on public.profiles (created_at);

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

-- Auto-create profile on signup (role defaults to operator)
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    coalesce(new.email, new.id::text),
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
    coalesce((new.raw_user_meta_data->>'role')::public.user_role, 'operator')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- -----------------------------------------------------------------------------
-- clients
-- -----------------------------------------------------------------------------

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  meta_account_id text,
  meta_account_name text,
  access_method public.access_method,
  access_status public.access_status not null default 'not_requested',
  budget_ceiling numeric(14, 2),
  brand_voice text,
  brand_colors text[],
  brand_guidelines text,
  target_audience text,
  standing_instructions text,
  business_description text,
  value_proposition text,
  website_url text,
  industry text,
  timezone text default 'UTC',
  currency text not null default 'USD',
  notes text,
  is_demo boolean not null default false,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint clients_budget_ceiling_nonnegative
    check (budget_ceiling is null or budget_ceiling >= 0)
);

create index clients_access_status_idx on public.clients (access_status);
create index clients_created_at_idx on public.clients (created_at);
create index clients_created_by_idx on public.clients (created_by);

create trigger clients_set_updated_at
before update on public.clients
for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- user_client_access
-- -----------------------------------------------------------------------------

create table public.user_client_access (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  granted_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  unique (user_id, client_id)
);

create index user_client_access_user_id_idx on public.user_client_access (user_id);
create index user_client_access_client_id_idx on public.user_client_access (client_id);
create index user_client_access_created_at_idx on public.user_client_access (created_at);

-- -----------------------------------------------------------------------------
-- Authz helpers (SECURITY DEFINER; used by RLS) — after profiles + access tables
-- -----------------------------------------------------------------------------

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role = 'admin'
      and p.is_active = true
  );
$$;

create or replace function public.has_client_access(p_client_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    public.is_admin()
    or exists (
      select 1
      from public.user_client_access uca
      where uca.user_id = auth.uid()
        and uca.client_id = p_client_id
    );
$$;

revoke all on function public.is_admin() from public;
revoke all on function public.has_client_access(uuid) from public;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.has_client_access(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- conversations
-- -----------------------------------------------------------------------------


create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  task_id uuid,
  title text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index conversations_client_id_idx on public.conversations (client_id);
create index conversations_user_id_idx on public.conversations (user_id);
create index conversations_created_at_idx on public.conversations (created_at);

create trigger conversations_set_updated_at
before update on public.conversations
for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- tasks
-- -----------------------------------------------------------------------------

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  conversation_id uuid references public.conversations (id) on delete set null,
  title text not null,
  user_request text,
  status public.task_status not null default 'queued',
  current_step text,
  agent_state jsonb,
  started_at timestamptz,
  paused_at timestamptz,
  completed_at timestamptz,
  error_message text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index tasks_client_id_idx on public.tasks (client_id);
create index tasks_user_id_idx on public.tasks (user_id);
create index tasks_status_idx on public.tasks (status);
create index tasks_created_at_idx on public.tasks (created_at);
create index tasks_conversation_id_idx on public.tasks (conversation_id);

create trigger tasks_set_updated_at
before update on public.tasks
for each row execute function public.set_updated_at();

-- Deferred FK: conversations.task_id → tasks.id
alter table public.conversations
  add constraint conversations_task_id_fkey
  foreign key (task_id) references public.tasks (id) on delete set null;

-- -----------------------------------------------------------------------------
-- messages
-- -----------------------------------------------------------------------------

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  task_id uuid references public.tasks (id) on delete set null,
  role public.message_role not null,
  content text not null,
  tool_call_id uuid,
  metadata jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index messages_conversation_id_idx on public.messages (conversation_id);
create index messages_task_id_idx on public.messages (task_id);
create index messages_created_at_idx on public.messages (created_at);

-- -----------------------------------------------------------------------------
-- tool_calls (append-only audit)
-- -----------------------------------------------------------------------------

create table public.tool_calls (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  conversation_id uuid references public.conversations (id) on delete set null,
  approval_id uuid,
  tool_name text not null,
  tool_type public.tool_safety_class not null,
  input jsonb not null default '{}'::jsonb,
  output jsonb,
  status public.tool_call_status not null default 'started',
  duration_ms integer,
  error text,
  created_at timestamptz not null default timezone('utc', now()),
  started_at timestamptz not null default timezone('utc', now()),
  completed_at timestamptz
);

create index tool_calls_task_id_idx on public.tool_calls (task_id);
create index tool_calls_client_id_idx on public.tool_calls (client_id);
create index tool_calls_status_idx on public.tool_calls (status);
create index tool_calls_created_at_idx on public.tool_calls (created_at);
create index tool_calls_tool_name_idx on public.tool_calls (tool_name);

-- -----------------------------------------------------------------------------
-- approvals
-- -----------------------------------------------------------------------------

create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  task_id uuid references public.tasks (id) on delete set null,
  tool_call_id uuid references public.tool_calls (id) on delete set null,
  client_id uuid not null references public.clients (id) on delete cascade,
  tool_name text not null,
  original_input jsonb not null default '{}'::jsonb,
  editable_input jsonb,
  human_summary text,
  agent_reasoning text,
  budget_impact numeric(14, 2),
  risk_level public.approval_risk_level not null default 'medium',
  status public.approval_status not null default 'pending',
  decided_by uuid references public.profiles (id) on delete set null,
  decision_notes text,
  requested_by uuid references public.profiles (id) on delete set null,
  idempotency_key text not null,
  expires_at timestamptz,
  execution_result jsonb,
  execution_error text,
  created_at timestamptz not null default timezone('utc', now()),
  decided_at timestamptz,
  executed_at timestamptz,
  updated_at timestamptz not null default timezone('utc', now()),
  unique (idempotency_key)
);

create index approvals_client_id_idx on public.approvals (client_id);
create index approvals_task_id_idx on public.approvals (task_id);
create index approvals_status_idx on public.approvals (status);
create index approvals_created_at_idx on public.approvals (created_at);
create index approvals_requested_by_idx on public.approvals (requested_by);

create trigger approvals_set_updated_at
before update on public.approvals
for each row execute function public.set_updated_at();

alter table public.tool_calls
  add constraint tool_calls_approval_id_fkey
  foreign key (approval_id) references public.approvals (id) on delete set null;

-- -----------------------------------------------------------------------------
-- adspirer_service_account (shared; tokens never exposed to anon)
-- -----------------------------------------------------------------------------

create table public.adspirer_service_account (
  id uuid primary key default gen_random_uuid(),
  label text not null default 'Adspirer Shared Service Account',
  access_token_encrypted text not null,
  refresh_token_encrypted text,
  expires_at timestamptz,
  scopes text[],
  provider_account_reference text,
  connection_status public.service_connection_status not null default 'disconnected',
  is_active boolean not null default true,
  last_sync_at timestamptz,
  last_refreshed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create unique index adspirer_service_account_one_active_idx
  on public.adspirer_service_account (is_active)
  where is_active = true;

create index adspirer_service_account_created_at_idx
  on public.adspirer_service_account (created_at);

create trigger adspirer_service_account_set_updated_at
before update on public.adspirer_service_account
for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- connected_meta_accounts
-- -----------------------------------------------------------------------------

create table public.connected_meta_accounts (
  id uuid primary key default gen_random_uuid(),
  external_account_id text not null unique,
  account_name text not null,
  business_id text,
  business_name text,
  currency text,
  timezone text,
  status public.meta_account_status not null default 'unknown',
  access_method public.access_method,
  access_status public.access_status not null default 'not_requested',
  mapped_client_id uuid references public.clients (id) on delete set null,
  last_synced_at timestamptz,
  raw_metadata jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index connected_meta_accounts_mapped_client_id_idx
  on public.connected_meta_accounts (mapped_client_id);
create index connected_meta_accounts_access_status_idx
  on public.connected_meta_accounts (access_status);
create index connected_meta_accounts_created_at_idx
  on public.connected_meta_accounts (created_at);

create trigger connected_meta_accounts_set_updated_at
before update on public.connected_meta_accounts
for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- oauth_clients (discovery / dynamic registration cache)
-- -----------------------------------------------------------------------------

create table public.oauth_clients (
  id uuid primary key default gen_random_uuid(),
  client_id text not null unique,
  client_secret_encrypted text,
  client_name text,
  redirect_uris text[] not null default '{}',
  grant_types text[] not null default array['authorization_code']::text[],
  response_types text[] not null default array['code']::text[],
  token_endpoint_auth_method text,
  registration_access_token_encrypted text,
  metadata jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index oauth_clients_created_at_idx on public.oauth_clients (created_at);

create trigger oauth_clients_set_updated_at
before update on public.oauth_clients
for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- oauth_pkce_state (single-use; expiry + consumed_at)
-- -----------------------------------------------------------------------------

create table public.oauth_pkce_state (
  id uuid primary key default gen_random_uuid(),
  state text not null unique,
  code_verifier text not null,
  redirect_uri text not null,
  created_by uuid references public.profiles (id) on delete set null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  constraint oauth_pkce_state_expires_after_created
    check (expires_at > created_at)
);

create index oauth_pkce_state_expires_at_idx on public.oauth_pkce_state (expires_at);
create index oauth_pkce_state_created_by_idx on public.oauth_pkce_state (created_by);
create index oauth_pkce_state_created_at_idx on public.oauth_pkce_state (created_at);

-- -----------------------------------------------------------------------------
-- client_access_requests
-- -----------------------------------------------------------------------------

create table public.client_access_requests (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  connected_meta_account_id uuid references public.connected_meta_accounts (id) on delete set null,
  access_method public.access_method not null,
  recipient_email text,
  instructions text,
  status public.access_status not null default 'requested',
  sent_via public.access_request_sent_via not null default 'none',
  sent_at timestamptz,
  last_followup_at timestamptz,
  marked_stale_at timestamptz,
  granted_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index client_access_requests_client_id_idx
  on public.client_access_requests (client_id);
create index client_access_requests_status_idx
  on public.client_access_requests (status);
create index client_access_requests_created_at_idx
  on public.client_access_requests (created_at);
create index client_access_requests_created_by_idx
  on public.client_access_requests (created_by);

create trigger client_access_requests_set_updated_at
before update on public.client_access_requests
for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- client_services
-- -----------------------------------------------------------------------------

create table public.client_services (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  name text not null,
  description text,
  landing_page_url text,
  keywords text[],
  priority integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index client_services_client_id_idx on public.client_services (client_id);
create index client_services_created_at_idx on public.client_services (created_at);

create trigger client_services_set_updated_at
before update on public.client_services
for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- competitors
-- -----------------------------------------------------------------------------

create table public.competitors (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  service_id uuid references public.client_services (id) on delete set null,
  name text not null,
  website text,
  estimated_size text,
  estimated_traffic text,
  positioning text,
  match_reason text,
  notes text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index competitors_client_id_idx on public.competitors (client_id);
create index competitors_service_id_idx on public.competitors (service_id);
create index competitors_created_at_idx on public.competitors (created_at);

create trigger competitors_set_updated_at
before update on public.competitors
for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- competitor_ads
-- -----------------------------------------------------------------------------

create table public.competitor_ads (
  id uuid primary key default gen_random_uuid(),
  competitor_id uuid not null references public.competitors (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  platform text not null default 'meta',
  external_ad_id text,
  headline text,
  primary_text text,
  cta text,
  destination_url text,
  creative_url text,
  media_type text,
  started_at timestamptz,
  ended_at timestamptz,
  status text,
  raw_data jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index competitor_ads_competitor_id_idx on public.competitor_ads (competitor_id);
create index competitor_ads_client_id_idx on public.competitor_ads (client_id);
create index competitor_ads_created_at_idx on public.competitor_ads (created_at);

-- -----------------------------------------------------------------------------
-- competitor_briefs
-- -----------------------------------------------------------------------------

create table public.competitor_briefs (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  service_id uuid references public.client_services (id) on delete set null,
  status public.competitor_brief_status not null default 'pending',
  summary text,
  patterns jsonb,
  differentiators jsonb,
  market_gaps jsonb,
  recommendations jsonb,
  strengths text[],
  weaknesses text[],
  messaging_themes text[],
  creative_patterns text[],
  opportunities text[],
  source_metadata jsonb,
  researched_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index competitor_briefs_client_id_idx on public.competitor_briefs (client_id);
create index competitor_briefs_status_idx on public.competitor_briefs (status);
create index competitor_briefs_created_at_idx on public.competitor_briefs (created_at);

create trigger competitor_briefs_set_updated_at
before update on public.competitor_briefs
for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- monitoring_snapshots
-- -----------------------------------------------------------------------------

create table public.monitoring_snapshots (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  meta_account_id text,
  captured_at timestamptz not null default timezone('utc', now()),
  period_start timestamptz,
  period_end timestamptz,
  date_range text,
  spend numeric(14, 2),
  impressions bigint,
  clicks bigint,
  ctr numeric(10, 4),
  cpc numeric(14, 4),
  cpm numeric(14, 4),
  leads numeric(14, 2),
  purchases numeric(14, 2),
  cpl numeric(14, 4),
  cpa numeric(14, 4),
  roas numeric(14, 4),
  raw_metrics jsonb not null default '{}'::jsonb,
  findings jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index monitoring_snapshots_client_id_idx on public.monitoring_snapshots (client_id);
create index monitoring_snapshots_created_at_idx on public.monitoring_snapshots (created_at);
create index monitoring_snapshots_captured_at_idx on public.monitoring_snapshots (captured_at);

-- -----------------------------------------------------------------------------
-- recommendations
-- -----------------------------------------------------------------------------

create table public.recommendations (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  task_id uuid references public.tasks (id) on delete set null,
  category text,
  title text not null,
  description text not null,
  evidence jsonb,
  expected_impact text,
  status public.recommendation_status not null default 'open',
  proposed_tool text,
  proposed_args jsonb,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index recommendations_client_id_idx on public.recommendations (client_id);
create index recommendations_status_idx on public.recommendations (status);
create index recommendations_created_at_idx on public.recommendations (created_at);
create index recommendations_task_id_idx on public.recommendations (task_id);

create trigger recommendations_set_updated_at
before update on public.recommendations
for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- notifications
-- -----------------------------------------------------------------------------

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  client_id uuid references public.clients (id) on delete cascade,
  type public.notification_type not null default 'system',
  title text not null,
  body text not null,
  href text,
  read_at timestamptz,
  created_at timestamptz not null default timezone('utc', now())
);

create index notifications_user_id_idx on public.notifications (user_id);
create index notifications_client_id_idx on public.notifications (client_id);
create index notifications_created_at_idx on public.notifications (created_at);
create index notifications_type_idx on public.notifications (type);

-- =============================================================================
-- Row Level Security
-- =============================================================================

alter table public.profiles enable row level security;
alter table public.clients enable row level security;
alter table public.user_client_access enable row level security;
alter table public.conversations enable row level security;
alter table public.tasks enable row level security;
alter table public.messages enable row level security;
alter table public.tool_calls enable row level security;
alter table public.approvals enable row level security;
alter table public.adspirer_service_account enable row level security;
alter table public.connected_meta_accounts enable row level security;
alter table public.oauth_clients enable row level security;
alter table public.oauth_pkce_state enable row level security;
alter table public.client_access_requests enable row level security;
alter table public.client_services enable row level security;
alter table public.competitors enable row level security;
alter table public.competitor_ads enable row level security;
alter table public.competitor_briefs enable row level security;
alter table public.monitoring_snapshots enable row level security;
alter table public.recommendations enable row level security;
alter table public.notifications enable row level security;

-- ---------- profiles ----------
create policy profiles_select_own_or_admin
  on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin());

create policy profiles_update_own
  on public.profiles for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

create policy profiles_admin_all
  on public.profiles for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ---------- clients ----------
create policy clients_select_access
  on public.clients for select to authenticated
  using (public.has_client_access(id));

create policy clients_admin_insert
  on public.clients for insert to authenticated
  with check (public.is_admin());

create policy clients_admin_update
  on public.clients for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy clients_admin_delete
  on public.clients for delete to authenticated
  using (public.is_admin());

-- ---------- user_client_access ----------
create policy user_client_access_select
  on public.user_client_access for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

create policy user_client_access_admin_write
  on public.user_client_access for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ---------- conversations ----------
create policy conversations_select
  on public.conversations for select to authenticated
  using (public.has_client_access(client_id));

create policy conversations_insert
  on public.conversations for insert to authenticated
  with check (public.has_client_access(client_id));

create policy conversations_update
  on public.conversations for update to authenticated
  using (public.has_client_access(client_id))
  with check (public.has_client_access(client_id));

create policy conversations_admin_delete
  on public.conversations for delete to authenticated
  using (public.is_admin());

-- ---------- tasks ----------
create policy tasks_select
  on public.tasks for select to authenticated
  using (public.has_client_access(client_id));

create policy tasks_insert
  on public.tasks for insert to authenticated
  with check (public.has_client_access(client_id));

create policy tasks_update
  on public.tasks for update to authenticated
  using (public.has_client_access(client_id))
  with check (public.has_client_access(client_id));

create policy tasks_admin_delete
  on public.tasks for delete to authenticated
  using (public.is_admin());

-- ---------- messages ----------
create policy messages_select
  on public.messages for select to authenticated
  using (
    exists (
      select 1 from public.conversations c
      where c.id = messages.conversation_id
        and public.has_client_access(c.client_id)
    )
  );

create policy messages_insert
  on public.messages for insert to authenticated
  with check (
    exists (
      select 1 from public.conversations c
      where c.id = messages.conversation_id
        and public.has_client_access(c.client_id)
    )
  );

create policy messages_admin_delete
  on public.messages for delete to authenticated
  using (public.is_admin());

-- ---------- tool_calls (append-only for authenticated: SELECT + INSERT only) ----------
create policy tool_calls_select
  on public.tool_calls for select to authenticated
  using (public.has_client_access(client_id));

create policy tool_calls_insert
  on public.tool_calls for insert to authenticated
  with check (public.has_client_access(client_id));

-- Explicitly no UPDATE / DELETE policies for authenticated → append-only.
-- Service role bypasses RLS for operational corrections if ever required.

-- ---------- approvals ----------
create policy approvals_select
  on public.approvals for select to authenticated
  using (public.has_client_access(client_id));

create policy approvals_insert
  on public.approvals for insert to authenticated
  with check (public.has_client_access(client_id));

create policy approvals_update
  on public.approvals for update to authenticated
  using (public.has_client_access(client_id))
  with check (public.has_client_access(client_id));

create policy approvals_admin_delete
  on public.approvals for delete to authenticated
  using (public.is_admin());

-- ---------- adspirer_service_account ----------
-- Never readable by anon. Authenticated users also have no SELECT/INSERT/UPDATE/DELETE
-- policies — only the service_role (bypasses RLS) may access tokens server-side.
-- (Intentionally no policies for anon or authenticated.)

-- ---------- connected_meta_accounts ----------
create policy connected_meta_accounts_select
  on public.connected_meta_accounts for select to authenticated
  using (
    public.is_admin()
    or (
      mapped_client_id is not null
      and public.has_client_access(mapped_client_id)
    )
  );

create policy connected_meta_accounts_admin_write
  on public.connected_meta_accounts for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ---------- oauth_clients / oauth_pkce_state (admin + service_role only) ----------
create policy oauth_clients_admin_all
  on public.oauth_clients for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy oauth_pkce_state_admin_all
  on public.oauth_pkce_state for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ---------- client_access_requests ----------
create policy client_access_requests_select
  on public.client_access_requests for select to authenticated
  using (public.has_client_access(client_id));

create policy client_access_requests_admin_write
  on public.client_access_requests for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ---------- client_services ----------
create policy client_services_select
  on public.client_services for select to authenticated
  using (public.has_client_access(client_id));

create policy client_services_admin_write
  on public.client_services for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ---------- competitors ----------
create policy competitors_select
  on public.competitors for select to authenticated
  using (public.has_client_access(client_id));

create policy competitors_insert
  on public.competitors for insert to authenticated
  with check (public.has_client_access(client_id));

create policy competitors_update
  on public.competitors for update to authenticated
  using (public.has_client_access(client_id))
  with check (public.has_client_access(client_id));

create policy competitors_admin_delete
  on public.competitors for delete to authenticated
  using (public.is_admin());

-- ---------- competitor_ads ----------
create policy competitor_ads_select
  on public.competitor_ads for select to authenticated
  using (public.has_client_access(client_id));

create policy competitor_ads_insert
  on public.competitor_ads for insert to authenticated
  with check (public.has_client_access(client_id));

create policy competitor_ads_admin_delete
  on public.competitor_ads for delete to authenticated
  using (public.is_admin());

-- ---------- competitor_briefs ----------
create policy competitor_briefs_select
  on public.competitor_briefs for select to authenticated
  using (public.has_client_access(client_id));

create policy competitor_briefs_insert
  on public.competitor_briefs for insert to authenticated
  with check (public.has_client_access(client_id));

create policy competitor_briefs_update
  on public.competitor_briefs for update to authenticated
  using (public.has_client_access(client_id))
  with check (public.has_client_access(client_id));

create policy competitor_briefs_admin_delete
  on public.competitor_briefs for delete to authenticated
  using (public.is_admin());

-- ---------- monitoring_snapshots ----------
create policy monitoring_snapshots_select
  on public.monitoring_snapshots for select to authenticated
  using (public.has_client_access(client_id));

create policy monitoring_snapshots_insert
  on public.monitoring_snapshots for insert to authenticated
  with check (public.has_client_access(client_id) or public.is_admin());

create policy monitoring_snapshots_admin_delete
  on public.monitoring_snapshots for delete to authenticated
  using (public.is_admin());

-- ---------- recommendations ----------
create policy recommendations_select
  on public.recommendations for select to authenticated
  using (public.has_client_access(client_id));

create policy recommendations_insert
  on public.recommendations for insert to authenticated
  with check (public.has_client_access(client_id));

create policy recommendations_update
  on public.recommendations for update to authenticated
  using (public.has_client_access(client_id))
  with check (public.has_client_access(client_id));

create policy recommendations_admin_delete
  on public.recommendations for delete to authenticated
  using (public.is_admin());

-- ---------- notifications ----------
create policy notifications_select_own
  on public.notifications for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

create policy notifications_update_own
  on public.notifications for update to authenticated
  using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());

create policy notifications_insert_admin
  on public.notifications for insert to authenticated
  with check (public.is_admin() or user_id = auth.uid());

create policy notifications_admin_delete
  on public.notifications for delete to authenticated
  using (public.is_admin());

-- =============================================================================
-- Grants
-- =============================================================================

grant usage on schema public to anon, authenticated;

grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.clients to authenticated;
grant select, insert, update, delete on public.user_client_access to authenticated;
grant select, insert, update, delete on public.conversations to authenticated;
grant select, insert, update, delete on public.tasks to authenticated;
grant select, insert, delete on public.messages to authenticated;
grant select, insert on public.tool_calls to authenticated;
grant select, insert, update, delete on public.approvals to authenticated;
-- adspirer_service_account: no grants to anon/authenticated (service_role only)
grant select, insert, update, delete on public.connected_meta_accounts to authenticated;
grant select, insert, update, delete on public.oauth_clients to authenticated;
grant select, insert, update, delete on public.oauth_pkce_state to authenticated;
grant select, insert, update, delete on public.client_access_requests to authenticated;
grant select, insert, update, delete on public.client_services to authenticated;
grant select, insert, update, delete on public.competitors to authenticated;
grant select, insert, delete on public.competitor_ads to authenticated;
grant select, insert, update, delete on public.competitor_briefs to authenticated;
grant select, insert, delete on public.monitoring_snapshots to authenticated;
grant select, insert, update, delete on public.recommendations to authenticated;
grant select, insert, update, delete on public.notifications to authenticated;
