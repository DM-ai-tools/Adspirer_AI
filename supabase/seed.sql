-- =============================================================================
-- Spendsmith — DEMO DATA seed
-- =============================================================================
-- CLEARLY LABELED DEMO DATA — do not use in production migrations.
--
-- auth.users prerequisite
-- ----------------------
-- `profiles.id` references `auth.users(id)`. Before this seed can insert
-- profiles (or anything that FKs to them), those auth users must exist.
--
-- Options:
--   1) DEMO_MODE=true (recommended for local UI) — app uses in-memory store;
--      you do not need this seed.sql at all. See scripts/seed-demo.md.
--   2) Local Supabase: uncomment the "LOCAL AUTH USERS" block below, then
--      run `supabase db reset` (applies migrations + seed).
--   3) Hosted Supabase: create users in the Dashboard (Auth → Users) or via
--      Admin API, then set their UUIDs to the fixed IDs below (or update the
--      IDs in this file to match), then run this seed against public tables.
--
-- Fixed demo UUIDs (stable across resets)
-- =============================================================================

-- Fixed profile / auth user IDs
-- admin:    a1111111-1111-4111-8111-111111111111
-- operator: a2222222-2222-4222-8222-222222222222

-- Fixed client IDs
-- TrafficRadius:         b1111111-1111-4111-8111-111111111111
-- ClickTrends:           b2222222-2222-4222-8222-222222222222
-- Modern Dental Centre:  b3333333-3333-4333-8333-333333333333

begin;

-- -----------------------------------------------------------------------------
-- LOCAL AUTH USERS (optional — uncomment for `supabase start` / `db reset`)
-- Hosted projects: create users in Dashboard/API instead; leave this commented.
-- -----------------------------------------------------------------------------
/*
insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at,
  confirmation_token,
  recovery_token,
  email_change_token_new,
  email_change
) values
(
  '00000000-0000-0000-0000-000000000000',
  'a1111111-1111-4111-8111-111111111111',
  'authenticated',
  'authenticated',
  'admin@spendsmith.demo',
  crypt('demo-password-admin', gen_salt('bf')),
  timezone('utc', now()),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"full_name":"Spendsmith Admin","role":"admin"}'::jsonb,
  timezone('utc', now()),
  timezone('utc', now()),
  '',
  '',
  '',
  ''
),
(
  '00000000-0000-0000-0000-000000000000',
  'a2222222-2222-4222-8222-222222222222',
  'authenticated',
  'authenticated',
  'operator@spendsmith.demo',
  crypt('demo-password-operator', gen_salt('bf')),
  timezone('utc', now()),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"full_name":"Spendsmith Operator","role":"operator"}'::jsonb,
  timezone('utc', now()),
  timezone('utc', now()),
  '',
  '',
  '',
  ''
)
on conflict (id) do nothing;

insert into auth.identities (
  id,
  user_id,
  identity_data,
  provider,
  provider_id,
  last_sign_in_at,
  created_at,
  updated_at
) values
(
  'a1111111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  jsonb_build_object('sub', 'a1111111-1111-4111-8111-111111111111', 'email', 'admin@spendsmith.demo'),
  'email',
  'a1111111-1111-4111-8111-111111111111',
  timezone('utc', now()),
  timezone('utc', now()),
  timezone('utc', now())
),
(
  'a2222222-2222-4222-8222-222222222222',
  'a2222222-2222-4222-8222-222222222222',
  jsonb_build_object('sub', 'a2222222-2222-4222-8222-222222222222', 'email', 'operator@spendsmith.demo'),
  'email',
  'a2222222-2222-4222-8222-222222222222',
  timezone('utc', now()),
  timezone('utc', now()),
  timezone('utc', now())
)
on conflict do nothing;
*/

-- -----------------------------------------------------------------------------
-- DEMO DATA: profiles
-- Assumes auth.users rows already exist for these IDs (or handle_new_user ran).
-- -----------------------------------------------------------------------------

insert into public.profiles (id, email, full_name, role, is_active)
values
  (
    'a1111111-1111-4111-8111-111111111111',
    'admin@spendsmith.demo',
    'Adspirer Admin',
    'admin',
    true
  ),
  (
    'a2222222-2222-4222-8222-222222222222',
    'operator@spendsmith.demo',
    'Adspirer Operator',
    'operator',
    true
  )
on conflict (id) do update
set
  email = excluded.email,
  full_name = excluded.full_name,
  role = excluded.role,
  is_active = excluded.is_active,
  updated_at = timezone('utc', now());

-- -----------------------------------------------------------------------------
-- DEMO DATA: clients
-- -----------------------------------------------------------------------------

insert into public.clients (
  id,
  name,
  slug,
  meta_account_id,
  meta_account_name,
  access_method,
  access_status,
  budget_ceiling,
  brand_voice,
  brand_colors,
  brand_guidelines,
  target_audience,
  standing_instructions,
  business_description,
  value_proposition,
  website_url,
  industry,
  timezone,
  currency,
  notes,
  is_demo,
  created_by
) values
(
  'b1111111-1111-4111-8111-111111111111',
  'TrafficRadius',
  'trafficradius',
  'act_400500600',
  'TrafficRadius Agency Ad Account',
  'direct_grant',
  'granted',
  10000.00,
  'Confident, data-driven, partnership-oriented',
  array['#0B3D91', '#F4A261'],
  'Lead with outcomes and local market expertise. DEMO DATA.',
  'Multi-location SMB brands seeking paid media growth',
  'Never increase daily spend by more than 20% in a single action. DEMO DATA.',
  'Full-service digital marketing agency specializing in Meta Ads for multi-location brands. DEMO DATA.',
  'Full-funnel Meta Ads management with transparent reporting',
  'https://trafficradius.example',
  'Digital Marketing Agency',
  'America/Chicago',
  'USD',
  'DEMO DATA — agency partner account',
  true,
  'a1111111-1111-4111-8111-111111111111'
),
(
  'b2222222-2222-4222-8222-222222222222',
  'ClickTrends',
  'clicktrends',
  'act_700800900',
  'ClickTrends Performance',
  'business_manager_partner',
  'requested',
  7500.00,
  'Sharp, experimental, ROI-obsessed',
  array['#111827', '#22C55E'],
  'Highlight testing velocity and attribution clarity. DEMO DATA.',
  'eCommerce brands scaling paid social',
  'Prefer creative tests before budget increases. DEMO DATA.',
  'Performance marketing shop focused on rapid Meta creative testing. DEMO DATA.',
  'Rapid creative testing + efficient Meta spend',
  'https://clicktrends.example',
  'Performance Marketing',
  'America/Los_Angeles',
  'USD',
  'DEMO DATA',
  true,
  'a1111111-1111-4111-8111-111111111111'
),
(
  'b3333333-3333-4333-8333-333333333333',
  'Modern Dental Centre',
  'modern-dental-centre',
  'act_100200300',
  'Modern Dental Centre — Main',
  'business_manager_partner',
  'granted',
  2500.00,
  'Warm, trustworthy, modern clinical care',
  array['#1B6CA8', '#E8F4FC', '#F8FAFC'],
  'Patient-first language. Emphasize comfort, technology, and local care. DEMO DATA.',
  'Families and professionals seeking cosmetic & general dentistry',
  'Keep new patient lead CPL under $25 when possible. DEMO DATA.',
  'Modern dental practice offering implants, veneers, and family care. DEMO DATA.',
  'Advanced dental care with a calm, modern patient experience',
  'https://moderndental.example',
  'Healthcare — Dental',
  'America/New_York',
  'USD',
  'DEMO DATA — primary demo client for agent audit flow',
  true,
  'a1111111-1111-4111-8111-111111111111'
)
on conflict (id) do nothing;

-- -----------------------------------------------------------------------------
-- DEMO DATA: user_client_access (operator → all 3 clients)
-- -----------------------------------------------------------------------------

insert into public.user_client_access (id, user_id, client_id, granted_by)
values
  (
    'c1111111-1111-4111-8111-111111111111',
    'a2222222-2222-4222-8222-222222222222',
    'b1111111-1111-4111-8111-111111111111',
    'a1111111-1111-4111-8111-111111111111'
  ),
  (
    'c2222222-2222-4222-8222-222222222222',
    'a2222222-2222-4222-8222-222222222222',
    'b2222222-2222-4222-8222-222222222222',
    'a1111111-1111-4111-8111-111111111111'
  ),
  (
    'c3333333-3333-4333-8333-333333333333',
    'a2222222-2222-4222-8222-222222222222',
    'b3333333-3333-4333-8333-333333333333',
    'a1111111-1111-4111-8111-111111111111'
  )
on conflict (user_id, client_id) do nothing;

-- -----------------------------------------------------------------------------
-- DEMO DATA: connected_meta_accounts
-- -----------------------------------------------------------------------------

insert into public.connected_meta_accounts (
  id,
  external_account_id,
  account_name,
  business_id,
  business_name,
  currency,
  timezone,
  status,
  access_method,
  access_status,
  mapped_client_id,
  last_synced_at,
  raw_metadata
) values
(
  'd1111111-1111-4111-8111-111111111111',
  'act_100200300',
  'Modern Dental Centre — Main',
  'bm_9001',
  'Modern Dental BM',
  'USD',
  'America/New_York',
  'active',
  'business_manager_partner',
  'granted',
  'b3333333-3333-4333-8333-333333333333',
  timezone('utc', now()),
  '{"demo": true, "label": "DEMO DATA"}'::jsonb
),
(
  'd2222222-2222-4222-8222-222222222222',
  'act_400500600',
  'TrafficRadius Agency Ad Account',
  'bm_9002',
  'TrafficRadius BM',
  'USD',
  'America/Chicago',
  'active',
  'direct_grant',
  'granted',
  'b1111111-1111-4111-8111-111111111111',
  timezone('utc', now()),
  '{"demo": true, "label": "DEMO DATA"}'::jsonb
),
(
  'd3333333-3333-4333-8333-333333333333',
  'act_700800900',
  'ClickTrends Performance',
  'bm_9003',
  'ClickTrends BM',
  'USD',
  'America/Los_Angeles',
  'active',
  'business_manager_partner',
  'requested',
  'b2222222-2222-4222-8222-222222222222',
  null,
  '{"demo": true, "label": "DEMO DATA"}'::jsonb
)
on conflict (external_account_id) do nothing;

-- -----------------------------------------------------------------------------
-- DEMO DATA: adspirer_service_account (encrypted placeholders — not real tokens)
-- -----------------------------------------------------------------------------

insert into public.adspirer_service_account (
  id,
  label,
  access_token_encrypted,
  refresh_token_encrypted,
  expires_at,
  scopes,
  provider_account_reference,
  connection_status,
  is_active,
  last_sync_at,
  last_refreshed_at
) values (
  'e1111111-1111-4111-8111-111111111111',
  'Adspirer Shared Service Account (DEMO DATA)',
  'v1:demo:placeholder:access_token_encrypted',
  'v1:demo:placeholder:refresh_token_encrypted',
  timezone('utc', now()) + interval '30 days',
  array['ads_read', 'ads_management'],
  'demo_adspirer_account',
  'connected',
  true,
  timezone('utc', now()),
  timezone('utc', now())
)
on conflict (id) do nothing;

-- -----------------------------------------------------------------------------
-- DEMO DATA: client_services (Modern Dental — Dental Implants, Veneers)
-- -----------------------------------------------------------------------------

insert into public.client_services (
  id,
  client_id,
  name,
  description,
  landing_page_url,
  keywords,
  priority,
  is_active
) values
(
  'f1111111-1111-4111-8111-111111111111',
  'b3333333-3333-4333-8333-333333333333',
  'Dental Implants',
  'Single and full-arch dental implant solutions. DEMO DATA.',
  'https://moderndental.example/implants',
  array['dental implants', 'tooth replacement', 'implant dentist'],
  1,
  true
),
(
  'f2222222-2222-4222-8222-222222222222',
  'b3333333-3333-4333-8333-333333333333',
  'Veneers',
  'Porcelain and composite veneers for smile makeovers. DEMO DATA.',
  'https://moderndental.example/veneers',
  array['veneers', 'porcelain veneers', 'smile makeover'],
  2,
  true
)
on conflict (id) do nothing;

-- -----------------------------------------------------------------------------
-- DEMO DATA: competitors + competitor_ads
-- -----------------------------------------------------------------------------

insert into public.competitors (
  id,
  client_id,
  service_id,
  name,
  website,
  estimated_size,
  estimated_traffic,
  positioning,
  match_reason,
  notes
) values
(
  'f3333333-3333-4333-8333-333333333333',
  'b3333333-3333-4333-8333-333333333333',
  'f1111111-1111-4111-8111-111111111111',
  'SmileWorks Dental',
  'https://smileworks.example',
  'local',
  'medium',
  'Speed-to-appointment and financing-forward. DEMO DATA.',
  'Same metro + implant/veneer overlap',
  'DEMO DATA — local competitor'
)
on conflict (id) do nothing;

insert into public.competitor_ads (
  id,
  competitor_id,
  client_id,
  platform,
  external_ad_id,
  headline,
  primary_text,
  cta,
  destination_url,
  media_type,
  started_at,
  status,
  raw_data
) values (
  'f4444444-4444-4444-8444-444444444444',
  'f3333333-3333-4333-8333-333333333333',
  'b3333333-3333-4333-8333-333333333333',
  'meta',
  'lib_sw_001',
  'Same-Week New Patient Appointments',
  'Book a comfortable cleaning this week. New patients welcome. DEMO DATA.',
  'Book Now',
  'https://smileworks.example/book',
  'image',
  timezone('utc', now()) - interval '14 days',
  'active',
  '{"demo": true}'::jsonb
)
on conflict (id) do nothing;

-- -----------------------------------------------------------------------------
-- DEMO DATA: competitor brief
-- -----------------------------------------------------------------------------

insert into public.competitor_briefs (
  id,
  client_id,
  service_id,
  status,
  summary,
  patterns,
  differentiators,
  market_gaps,
  recommendations,
  strengths,
  weaknesses,
  messaging_themes,
  creative_patterns,
  opportunities,
  source_metadata,
  researched_at
) values (
  'f5555555-5555-4555-8555-555555555555',
  'b3333333-3333-4333-8333-333333333333',
  'f2222222-2222-4222-8222-222222222222',
  'ready',
  'Local competitors emphasize speed-to-appointment and financing. Opportunity to differentiate on technology and calm patient experience. DEMO DATA.',
  '["urgency CTAs", "financing mentions", "same-week booking"]'::jsonb,
  '["warm clinical tone", "modern tech", "comfort-first"]'::jsonb,
  '["fewer implant education creatives", "weak aftercare messaging"]'::jsonb,
  '["Lead with same-week cosmetic consult", "Test financing in primary text"]'::jsonb,
  array['Warm clinical tone', 'Strong local trust signals'],
  array['Fewer urgency CTAs than SmileWorks'],
  array['Comfort', 'Modern tech', 'Family care'],
  array['Before/after smiles', 'Team portraits', 'Office walkthrough'],
  array[
    'Lead with same-week cosmetic consult availability',
    'Test financing mention in primary text'
  ],
  '{"source": "mock", "demo": true, "label": "DEMO DATA"}'::jsonb,
  timezone('utc', now())
)
on conflict (id) do nothing;

-- -----------------------------------------------------------------------------
-- DEMO DATA: conversation + task + messages
-- -----------------------------------------------------------------------------

insert into public.conversations (id, client_id, user_id, title)
values (
  'aa111111-1111-4111-8111-111111111111',
  'b3333333-3333-4333-8333-333333333333',
  'a2222222-2222-4222-8222-222222222222',
  'MDC account audit (DEMO DATA)'
)
on conflict (id) do nothing;

insert into public.tasks (
  id,
  client_id,
  user_id,
  conversation_id,
  title,
  user_request,
  status,
  current_step,
  agent_state,
  started_at
) values (
  'bb111111-1111-4111-8111-111111111111',
  'b3333333-3333-4333-8333-333333333333',
  'a2222222-2222-4222-8222-222222222222',
  'aa111111-1111-4111-8111-111111111111',
  'Audit Modern Dental Meta account',
  'Please audit the Modern Dental Centre Meta account and suggest optimizations. DEMO DATA.',
  'waiting_approval',
  'awaiting_approval',
  jsonb_build_object(
    'phase', 'awaiting_approval',
    'last_tool', 'update_adset_budget',
    'findings', jsonb_build_array(
      'CPA rising on New Patient Leads ad set',
      'Frequency healthy'
    ),
    'demo', true
  ),
  timezone('utc', now()) - interval '1 hour'
)
on conflict (id) do nothing;

update public.conversations
set task_id = 'bb111111-1111-4111-8111-111111111111'
where id = 'aa111111-1111-4111-8111-111111111111';

insert into public.messages (
  id,
  conversation_id,
  task_id,
  role,
  content,
  metadata
) values
(
  'cc111111-1111-4111-8111-111111111111',
  'aa111111-1111-4111-8111-111111111111',
  'bb111111-1111-4111-8111-111111111111',
  'user',
  'Please audit the Modern Dental Centre Meta account and suggest optimizations. DEMO DATA.',
  '{"demo": true}'::jsonb
),
(
  'cc222222-2222-4222-8222-222222222222',
  'aa111111-1111-4111-8111-111111111111',
  'bb111111-1111-4111-8111-111111111111',
  'assistant',
  'I reviewed the account. New Patient Leads is delivery-constrained. I propose raising the ad set daily budget from $40 to $55 (within ceiling). Awaiting your approval. DEMO DATA.',
  '{"demo": true}'::jsonb
)
on conflict (id) do nothing;

-- -----------------------------------------------------------------------------
-- DEMO DATA: tool_call + pending approval
-- -----------------------------------------------------------------------------

insert into public.tool_calls (
  id,
  task_id,
  client_id,
  conversation_id,
  tool_name,
  tool_type,
  input,
  output,
  status,
  started_at
) values (
  'dd111111-1111-4111-8111-111111111111',
  'bb111111-1111-4111-8111-111111111111',
  'b3333333-3333-4333-8333-333333333333',
  'aa111111-1111-4111-8111-111111111111',
  'update_adset_budget',
  'execute',
  jsonb_build_object(
    'account_id', 'act_100200300',
    'adset_id', 'adset_mdc_npl_1',
    'daily_budget', 55,
    'previous_daily_budget', 40,
    'demo', true
  ),
  null,
  'awaiting_approval',
  timezone('utc', now()) - interval '30 minutes'
)
on conflict (id) do nothing;

insert into public.approvals (
  id,
  task_id,
  tool_call_id,
  client_id,
  tool_name,
  original_input,
  editable_input,
  human_summary,
  agent_reasoning,
  budget_impact,
  risk_level,
  status,
  requested_by,
  idempotency_key,
  expires_at
) values (
  'ee111111-1111-4111-8111-111111111111',
  'bb111111-1111-4111-8111-111111111111',
  'dd111111-1111-4111-8111-111111111111',
  'b3333333-3333-4333-8333-333333333333',
  'update_adset_budget',
  jsonb_build_object(
    'account_id', 'act_100200300',
    'adset_id', 'adset_mdc_npl_1',
    'daily_budget', 55,
    'previous_daily_budget', 40,
    'demo', true
  ),
  null,
  'Raise New Patient Leads daily budget $40 → $55. DEMO DATA.',
  'Delivery-constrained ad set; increase stays under client budget_ceiling. DEMO DATA.',
  15.00,
  'medium',
  'pending',
  'a2222222-2222-4222-8222-222222222222',
  'idem_demo_mdc_budget_1',
  timezone('utc', now()) + interval '72 hours'
)
on conflict (id) do nothing;

update public.tool_calls
set approval_id = 'ee111111-1111-4111-8111-111111111111'
where id = 'dd111111-1111-4111-8111-111111111111';

-- -----------------------------------------------------------------------------
-- DEMO DATA: monitoring snapshots
-- -----------------------------------------------------------------------------

insert into public.monitoring_snapshots (
  id,
  client_id,
  meta_account_id,
  captured_at,
  period_start,
  period_end,
  date_range,
  spend,
  impressions,
  clicks,
  ctr,
  cpc,
  cpm,
  leads,
  purchases,
  cpl,
  cpa,
  roas,
  raw_metrics,
  findings
) values
(
  'ff111111-1111-4111-8111-111111111111',
  'b3333333-3333-4333-8333-333333333333',
  'act_100200300',
  timezone('utc', now()),
  timezone('utc', now()) - interval '7 days',
  timezone('utc', now()),
  'last_7_days',
  612.40,
  48200,
  1140,
  2.3600,
  0.5400,
  12.7000,
  38,
  0,
  16.1200,
  null,
  null,
  jsonb_build_object(
    'spend', 612.40,
    'impressions', 48200,
    'clicks', 1140,
    'ctr', 2.36,
    'cpc', 0.54,
    'leads', 38,
    'cpl', 16.12,
    'frequency', 1.8,
    'reach', 26700,
    'demo', true
  ),
  jsonb_build_array(
    jsonb_build_object(
      'code', 'CPL_UP',
      'severity', 'warning',
      'title', 'CPL above 14-day baseline',
      'detail', 'Cost per lead rose 18% week-over-week on New Patient Leads. DEMO DATA.',
      'metric_key', 'cpl',
      'metric_value', 16.12,
      'baseline_value', 13.65
    )
  )
),
(
  'ff222222-2222-4222-8222-222222222222',
  'b3333333-3333-4333-8333-333333333333',
  'act_100200300',
  timezone('utc', now()) - interval '7 days',
  timezone('utc', now()) - interval '14 days',
  timezone('utc', now()) - interval '7 days',
  'prior_7_days',
  540.10,
  44100,
  1050,
  2.3800,
  0.5100,
  12.2500,
  42,
  0,
  12.8600,
  null,
  null,
  jsonb_build_object(
    'spend', 540.10,
    'impressions', 44100,
    'clicks', 1050,
    'ctr', 2.38,
    'cpc', 0.51,
    'leads', 42,
    'cpl', 12.86,
    'frequency', 1.7,
    'reach', 25900,
    'demo', true
  ),
  '[]'::jsonb
)
on conflict (id) do nothing;

-- -----------------------------------------------------------------------------
-- DEMO DATA: recommendation + notifications + access request
-- -----------------------------------------------------------------------------

insert into public.recommendations (
  id,
  client_id,
  task_id,
  category,
  title,
  description,
  evidence,
  expected_impact,
  status,
  proposed_tool,
  proposed_args,
  created_by
) values (
  'ab111111-1111-4111-8111-111111111111',
  'b3333333-3333-4333-8333-333333333333',
  'bb111111-1111-4111-8111-111111111111',
  'budget',
  'Increase New Patient Leads budget',
  'Raise daily budget $40 → $55 to relieve delivery constraints. DEMO DATA.',
  jsonb_build_object('finding', 'delivery_constrained', 'demo', true),
  'Improved delivery with CPL held near baseline',
  'open',
  'update_adset_budget',
  jsonb_build_object(
    'account_id', 'act_100200300',
    'adset_id', 'adset_mdc_npl_1',
    'daily_budget', 55
  ),
  'a2222222-2222-4222-8222-222222222222'
)
on conflict (id) do nothing;

insert into public.notifications (
  id,
  user_id,
  client_id,
  type,
  title,
  body,
  href
) values
(
  'ac111111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'b3333333-3333-4333-8333-333333333333',
  'approval_pending',
  'Approval needed: update_adset_budget',
  'Modern Dental Centre — raise New Patient Leads daily budget to $55. DEMO DATA.',
  '/clients/b3333333-3333-4333-8333-333333333333/approvals/ee111111-1111-4111-8111-111111111111'
),
(
  'ac222222-2222-4222-8222-222222222222',
  'a2222222-2222-4222-8222-222222222222',
  'b3333333-3333-4333-8333-333333333333',
  'approval_pending',
  'Your task is waiting on approval',
  'Audit Modern Dental Meta account — budget change pending. DEMO DATA.',
  '/clients/b3333333-3333-4333-8333-333333333333/approvals/ee111111-1111-4111-8111-111111111111'
),
(
  'ac333333-3333-4333-8333-333333333333',
  'a1111111-1111-4111-8111-111111111111',
  'b2222222-2222-4222-8222-222222222222',
  'access_stale',
  'Access still pending: ClickTrends',
  'ClickTrends partner access request has not been granted. DEMO DATA.',
  '/admin/access'
)
on conflict (id) do nothing;

insert into public.client_access_requests (
  id,
  client_id,
  connected_meta_account_id,
  access_method,
  recipient_email,
  instructions,
  status,
  sent_via,
  sent_at,
  created_by
) values (
  'ad111111-1111-4111-8111-111111111111',
  'b2222222-2222-4222-8222-222222222222',
  'd3333333-3333-4333-8333-333333333333',
  'business_manager_partner',
  'ads@clicktrends.example',
  'Invite Adspirer BM as partner with Ads management. DEMO DATA.',
  'requested',
  'manual',
  timezone('utc', now()),
  'a2222222-2222-4222-8222-222222222222'
)
on conflict (id) do nothing;

commit;
