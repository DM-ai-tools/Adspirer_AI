/**
 * Domain types aligned with the Adspirer AI database schema.
 * All timestamps are ISO-8601 strings unless noted.
 */

export type UserRole = "admin" | "operator";

export type TaskStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "paused"
  | "done"
  | "error"
  | "cancelled";

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "edited"
  | "executing"
  | "executed"
  | "failed"
  | "cancelled";

export type ToolSafetyClass = "diagnose" | "execute" | "blocked";

export type AccessMethod = "business_manager_partner" | "direct_grant";

export type AccessStatus =
  | "not_requested"
  | "requested"
  | "granted"
  | "stale"
  | "revoked";

export type AdsExecutionMode = "mock" | "sandbox" | "production";

export type MessageRole = "user" | "assistant" | "system" | "tool";

export type NotificationType =
  | "approval_pending"
  | "approval_executed"
  | "task_error"
  | "access_stale"
  | "monitoring_alert"
  | "system";

export type RecommendationStatus =
  | "open"
  | "accepted"
  | "dismissed"
  | "expired";

export type CompetitorBriefStatus = "pending" | "ready" | "failed";

export interface Profile {
  id: string;
  email: string;
  full_name: string | null;
  role: UserRole;
  avatar_url: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Client {
  id: string;
  name: string;
  slug: string;
  website_url: string | null;
  industry: string | null;
  brand_voice: string | null;
  brand_colors: string[] | null;
  brand_guidelines: string | null;
  target_audience: string | null;
  value_proposition: string | null;
  budget_ceiling_cents: number | null;
  currency: string;
  notes: string | null;
  is_demo: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserClientAccess {
  id: string;
  user_id: string;
  client_id: string;
  granted_by: string | null;
  created_at: string;
}

export interface Task {
  id: string;
  client_id: string;
  conversation_id: string | null;
  created_by: string;
  title: string;
  goal: string | null;
  status: TaskStatus;
  agent_state: Record<string, unknown> | null;
  error_message: string | null;
  paused_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Conversation {
  id: string;
  client_id: string;
  task_id: string | null;
  created_by: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: MessageRole;
  content: string;
  tool_call_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface ToolCall {
  id: string;
  task_id: string;
  conversation_id: string | null;
  tool_name: string;
  safety_class: ToolSafetyClass;
  arguments: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error_message: string | null;
  approval_id: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface Approval {
  id: string;
  client_id: string;
  task_id: string | null;
  tool_call_id: string | null;
  tool_name: string;
  proposed_args: Record<string, unknown>;
  edited_args: Record<string, unknown> | null;
  status: ApprovalStatus;
  rationale: string | null;
  budget_impact_cents: number | null;
  idempotency_key: string;
  requested_by: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  expires_at: string | null;
  execution_result: Record<string, unknown> | null;
  execution_error: string | null;
  executed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AdspirerServiceAccount {
  id: string;
  label: string;
  encrypted_access_token: string;
  encrypted_refresh_token: string | null;
  token_expires_at: string | null;
  scopes: string[] | null;
  is_active: boolean;
  last_refreshed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConnectedMetaAccount {
  id: string;
  client_id: string | null;
  meta_account_id: string;
  meta_account_name: string;
  currency: string | null;
  timezone: string | null;
  business_id: string | null;
  access_status: AccessStatus;
  access_method: AccessMethod | null;
  last_synced_at: string | null;
  raw: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface ClientAccessRequest {
  id: string;
  client_id: string;
  connected_meta_account_id: string | null;
  access_method: AccessMethod;
  status: AccessStatus;
  instructions: string | null;
  recipient_email: string | null;
  sent_at: string | null;
  sent_manually: boolean;
  marked_stale_at: string | null;
  granted_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CompetitorBrief {
  id: string;
  client_id: string;
  client_service_id: string | null;
  status: CompetitorBriefStatus;
  summary: string | null;
  strengths: string[] | null;
  weaknesses: string[] | null;
  messaging_themes: string[] | null;
  creative_patterns: string[] | null;
  opportunities: string[] | null;
  raw_research: Record<string, unknown> | null;
  generated_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClientService {
  id: string;
  client_id: string;
  name: string;
  description: string | null;
  keywords: string[] | null;
  /** Matches Supabase column `landing_page_url` */
  landing_page_url: string | null;
  priority?: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Competitor {
  id: string;
  client_id: string;
  name: string;
  website_url: string | null;
  domain: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface CompetitorAd {
  id: string;
  competitor_id: string;
  client_id: string;
  platform: string;
  ad_library_id: string | null;
  headline: string | null;
  body: string | null;
  cta: string | null;
  media_type: string | null;
  media_url: string | null;
  landing_url: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  raw: Record<string, unknown> | null;
  created_at: string;
}

export interface MonitoringSnapshot {
  id: string;
  client_id: string;
  meta_account_id: string | null;
  period_start: string;
  period_end: string;
  metrics: Record<string, number>;
  findings: MonitoringFinding[] | null;
  created_at: string;
}

export interface MonitoringFinding {
  code: string;
  severity: "info" | "warning" | "critical";
  title: string;
  detail: string;
  metric_key?: string;
  metric_value?: number;
  baseline_value?: number;
}

export interface Recommendation {
  id: string;
  client_id: string;
  task_id: string | null;
  title: string;
  description: string;
  category: string | null;
  status: RecommendationStatus;
  proposed_tool: string | null;
  proposed_args: Record<string, unknown> | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface Notification {
  id: string;
  user_id: string;
  client_id: string | null;
  type: NotificationType;
  title: string;
  body: string;
  href: string | null;
  read_at: string | null;
  created_at: string;
}

export interface OAuthPkceState {
  id: string;
  state: string;
  code_verifier: string;
  redirect_uri: string;
  created_by: string | null;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
}
