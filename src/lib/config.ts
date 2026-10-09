import { z } from "zod";
import type { AdsExecutionMode } from "@/types";

const boolFromEnv = z.preprocess((value) => {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off", ""].includes(normalized)) return false;
  return value;
}, z.boolean());

const envSchema = z.object({
  DEMO_MODE: boolFromEnv.default(true),
  ADS_EXECUTION_MODE: z
    .enum(["mock", "sandbox", "production"])
    .default("mock"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  ACCESS_REQUEST_STALE_DAYS: z.coerce.number().int().positive().default(7),
  APPROVAL_EXPIRY_HOURS: z.coerce.number().int().positive().default(72),
  BUDGET_CEILING_DEFAULT_CENTS: z.coerce.number().int().nonnegative().default(500_000),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  NEXT_PUBLIC_SUPABASE_URL: z.string().optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  TOKEN_ENCRYPTION_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  // Retired IDs like claude-sonnet-4-20250514 return 404 — default to current Sonnet.
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-4-6"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-4o-mini"),
  FIRECRAWL_API_KEY: z.string().optional(),
  OPENAI_IMAGE_MODEL: z.string().default("gpt-image-2"),
  SOCIAVAULT_API_KEY: z.string().optional(),
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_GRAPH_VERSION: z.string().default("v23.0"),
  WORKSPACE_V2_ENABLED: boolFromEnv.default(false),
  R2_BUCKET: z.string().optional(),
  R2_ENDPOINT: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  // Comma-separated email domains allowed to self-register (e.g. "agency.com").
  // Empty = any domain; new self-registered users are always operators with no
  // client access until an admin assigns clients.
  SIGNUP_ALLOWED_DOMAINS: z.string().optional(),
  TRIGGER_SECRET_KEY: z.string().optional(),
  // Run chat turns as Trigger.dev jobs instead of inside the web request.
  // Needs the Trigger worker running (`npm run trigger:dev`, or deployed).
  AGENT_BACKGROUND_RUNS: boolFromEnv.default(false),
});

export type AppConfig = z.infer<typeof envSchema> & {
  isDemoMode: boolean;
  hasSupabase: boolean;
  hasAnthropic: boolean;
  hasOpenAI: boolean;
  hasFirecrawl: boolean;
  hasSociaVault: boolean;
  workspaceV2Enabled: boolean;
  adsExecutionMode: AdsExecutionMode;
};

function readRawEnv(): Record<string, string | undefined> {
  return {
    DEMO_MODE: process.env.DEMO_MODE,
    ADS_EXECUTION_MODE: process.env.ADS_EXECUTION_MODE,
    APP_URL: process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL,
    ACCESS_REQUEST_STALE_DAYS: process.env.ACCESS_REQUEST_STALE_DAYS,
    APPROVAL_EXPIRY_HOURS: process.env.APPROVAL_EXPIRY_HOURS,
    BUDGET_CEILING_DEFAULT_CENTS: process.env.BUDGET_CEILING_DEFAULT_CENTS,
    NODE_ENV: process.env.NODE_ENV,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    TOKEN_ENCRYPTION_KEY: process.env.TOKEN_ENCRYPTION_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_MODEL: process.env.OPENAI_MODEL,
    FIRECRAWL_API_KEY: process.env.FIRECRAWL_API_KEY,
    OPENAI_IMAGE_MODEL: process.env.OPENAI_IMAGE_MODEL,
    SOCIAVAULT_API_KEY: process.env.SOCIAVAULT_API_KEY,
    META_APP_ID: process.env.META_APP_ID,
    META_APP_SECRET: process.env.META_APP_SECRET,
    META_GRAPH_VERSION: process.env.META_GRAPH_VERSION,
    WORKSPACE_V2_ENABLED: process.env.WORKSPACE_V2_ENABLED,
    R2_BUCKET: process.env.R2_BUCKET,
    R2_ENDPOINT: process.env.R2_ENDPOINT,
    R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
    CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME,
    CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY,
    CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET,
    LOG_LEVEL: process.env.LOG_LEVEL,
    SIGNUP_ALLOWED_DOMAINS: process.env.SIGNUP_ALLOWED_DOMAINS,
    TRIGGER_SECRET_KEY: process.env.TRIGGER_SECRET_KEY,
    AGENT_BACKGROUND_RUNS: process.env.AGENT_BACKGROUND_RUNS,
  };
}

let cachedConfig: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (cachedConfig) return cachedConfig;

  const parsed = envSchema.parse(readRawEnv());
  const hasSupabase = Boolean(
    parsed.NEXT_PUBLIC_SUPABASE_URL && parsed.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );

  // Fail open to demo when Supabase is missing unless DEMO_MODE was explicitly false
  // and credentials exist. Explicit DEMO_MODE=true always wins.
  const isDemoMode =
    parsed.DEMO_MODE ||
    (!hasSupabase && process.env.DEMO_MODE !== "false");

  cachedConfig = {
    ...parsed,
    DEMO_MODE: isDemoMode,
    isDemoMode,
    hasSupabase,
    hasAnthropic: Boolean(parsed.ANTHROPIC_API_KEY),
    hasOpenAI: Boolean(parsed.OPENAI_API_KEY),
    hasFirecrawl: Boolean(parsed.FIRECRAWL_API_KEY),
    hasSociaVault: Boolean(parsed.SOCIAVAULT_API_KEY),
    workspaceV2Enabled: parsed.WORKSPACE_V2_ENABLED,
    adsExecutionMode: parsed.ADS_EXECUTION_MODE,
  };

  return cachedConfig;
}

/** Reset cached config (tests / hot-reload env changes). */
export function resetConfigCache(): void {
  cachedConfig = null;
}

export function isProductionAdsMode(): boolean {
  return getConfig().adsExecutionMode === "production";
}
