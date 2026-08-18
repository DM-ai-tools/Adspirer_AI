export type {
  UserRole,
  TaskStatus,
  ApprovalStatus,
  ToolSafetyClass,
  AccessMethod,
  AccessStatus,
  AdsExecutionMode,
  MessageRole,
  NotificationType,
  RecommendationStatus,
  CompetitorBriefStatus,
  Profile,
  Client,
  UserClientAccess,
  Task,
  Conversation,
  Message,
  ToolCall,
  Approval,
  AdspirerServiceAccount,
  ConnectedMetaAccount,
  ClientAccessRequest,
  CompetitorBrief,
  ClientService,
  Competitor,
  CompetitorAd,
  MonitoringSnapshot,
  MonitoringFinding,
  Recommendation,
  Notification,
  OAuthPkceState,
} from "./database";

export const ADS_EXECUTION_MODE = {
  MOCK: "mock",
  SANDBOX: "sandbox",
  PRODUCTION: "production",
} as const;

export const USER_ROLES = {
  ADMIN: "admin",
  OPERATOR: "operator",
} as const;

export const TASK_STATUSES = [
  "queued",
  "running",
  "waiting_approval",
  "paused",
  "done",
  "error",
  "cancelled",
] as const;

export const APPROVAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "edited",
  "executing",
  "executed",
  "failed",
  "cancelled",
] as const;

export const TOOL_SAFETY_CLASSES = ["diagnose", "execute", "blocked"] as const;

export const ACCESS_METHODS = [
  "business_manager_partner",
  "direct_grant",
] as const;

export const ACCESS_STATUSES = [
  "not_requested",
  "requested",
  "granted",
  "stale",
  "revoked",
] as const;
