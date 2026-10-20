import { z } from "zod";
import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { logger } from "@/lib/observability/logger";
import { isAdmin } from "@/lib/security/roles";
import { categoriesFromServices, scopeCategoriesFromRequest, type StrategyCategory } from "@/lib/strategy/categories";
import { matchCategoryByLabel } from "@/lib/strategy/category-match";
import { requestedCategoryPhrase } from "@/lib/strategy/requested-category";
import { nowIso } from "@/lib/utils";
import type { Client, ClientService, Profile } from "@/types";
import {
  ATTRIBUTION_SETTINGS,
  BUSINESS_MODELS,
  goalsProfileSchema,
  type GoalsProfile,
} from "./goals";
import { toClientDbPatch } from "./map-client";
import { clientPatchSchema } from "./patch";
import { servicePatchSchema } from "./service-schema";

/**
 * Client settings typed in the chat ("our margin is 40%", "always exclude NZ"):
 * found by a cheap word gate plus an LLM read, checked with the Settings form's
 * rules, and saved for admins. Every save is reported back to the writer and
 * recorded as an `update_client_settings` tool call.
 */

// ---------------------------------------------------------------------------
// Gate

const SETTING_WORDS =
  /\b(?:roas|margins?|cpa|order\s+value|aov|caps?|budget\s+ceiling|ceiling|business\s+model|e-?commerce|lead[\s-]?gen|industry|website|instructions?|always|never|countr(?:y|ies)|attribution|description)\b/i;

/** Only messages with a setting word go on to the LLM. */
export function mentionsSettings(message: string): boolean {
  return SETTING_WORDS.test(message);
}

// ---------------------------------------------------------------------------
// What the LLM may return

const MONEY_FIELDS = ["average_value", "target_cpa", "daily_account_cap", "monthly_cap", "budget_ceiling"] as const;
const TEXT_FIELDS = ["industry", "website_url", "business_description", "standing_instruction"] as const;
type MoneyField = (typeof MONEY_FIELDS)[number];
type TextField = (typeof TEXT_FIELDS)[number];

/** "$1,200" → 1200, "30k" → 30000, "40%" → 40, "8x" → 8. */
const looseNumber = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const m = /^\s*[^\d.-]*\s*(-?\d[\d,]*(?:\.\d+)?)\s*(k|m)?\s*(?:%|x|×)?\s*$/i.exec(value);
  if (!m) return Number.NaN;
  const n = Number(m[1].replace(/,/g, ""));
  return m[2]?.toLowerCase() === "k" ? n * 1000 : m[2]?.toLowerCase() === "m" ? n * 1_000_000 : n;
}, z.number().finite());
const text = z.string().trim().min(1);

const chatSettingSchema = z.union([
  z.object({ field: z.enum(["target_roas", "gross_margin_pct"]), value: looseNumber }),
  z.object({ field: z.enum(MONEY_FIELDS), value: looseNumber }),
  z.object({ field: z.literal("business_model"), value: z.enum(BUSINESS_MODELS) }),
  z.object({ field: z.literal("attribution"), value: z.enum(ATTRIBUTION_SETTINGS) }),
  z.object({ field: z.enum(TEXT_FIELDS), value: text }),
  z.object({
    field: z.literal("allowed_countries"),
    value: z.array(z.string().trim().transform((c) => c.toUpperCase())).min(1),
  }),
  z.object({
    field: z.enum(["category_margin", "category_average_value"]),
    category: text,
    value: looseNumber,
  }),
]);

export type ChatSetting = z.infer<typeof chatSettingSchema>;
type CategorySetting = Extract<ChatSetting, { category: string }>;

// ---------------------------------------------------------------------------
// Deterministic guard: the LLM's reading must be backed by a plain statement.

/** Words a clause must contain for each field to count as stated there. */
const FIELD_WORDS: Record<ChatSetting["field"], RegExp> = {
  target_roas: /\broas\b|return\s+on\s+ad\s+spend/i,
  gross_margin_pct: /\bmargins?\b/i,
  category_margin: /\bmargins?\b/i,
  average_value: /\b(?:order|lead|basket|average)\s+value\b|\baov\b/i,
  category_average_value: /\b(?:order|lead|basket|average)\s+value\b|\baov\b/i,
  target_cpa: /\bcpa\b|\bcost\s+per\s+(?:acquisition|lead|purchase|result|sale)\b/i,
  daily_account_cap: /\bcaps?\b|\bceiling\b|\blimit\b|\bmax(?:imum)?\b/i,
  monthly_cap: /\bcaps?\b|\bceiling\b|\blimit\b|\bmax(?:imum)?\b/i,
  budget_ceiling: /\bceiling\b/i,
  business_model: /\be-?commerce\b|\blead[\s-]?gen|\blocal\s+service|\bb2b\b|\bbusiness\s+model\b/i,
  attribution: /\battribution\b/i,
  industry: /\bindustry\b|\bsector\b/i,
  website_url: /\bwebsite\b/i,
  business_description: /\bdescription\b/i,
  standing_instruction: /\balways\b|\bnever\b|\binstructions?\b/i,
  allowed_countries: /\bcountr(?:y|ies)\b/i,
};
/** Fields a plan or strategy ask carries that are never settings ("$500/day", "hit 10x"). */
const PLAN_FIELDS = new Set<ChatSetting["field"]>(["target_roas", "daily_account_cap", "monthly_cap", "budget_ceiling"]);
const HYPOTHETICAL =
  /\b(?:what\s+if|suppose|supposing|hypothetical(?:ly)?|imagine|what\s+would|would\s+it|could\s+we|if\s+we)\b/i;
const PLAN_ASK = /\b(?:plan|strategy|strategi[sz]e|hit|reach|get\s+to|how\s+(?:do|can|should|would)\s+we)\b/i;
const SET_VERB = /\b(?:set|save|update|change|make|use)\b/i;
/** Asking to look at a site isn't stating the client's website. */
const SITE_LOOKUP = /\b(?:scrape|scan|crawl|analy[sz]e|audit|check|look\s+at|visit)\b/i;

/**
 * A strategy ask whose target is the whole account's: not a hypothetical, and
 * naming no category (loaded, or one the ask asks for by "on bar stools").
 */
export function isWholeAccountAsk(texts: string[], categories: StrategyCategory[]): boolean {
  return texts.every(
    (t) =>
      !HYPOTHETICAL.test(t) &&
      !scopeCategoriesFromRequest(t, categories).length &&
      !requestedCategoryPhrase(t, "strategy"),
  );
}

/** Clauses split on sentence ends, ";" and ", " (keeping "$30,000" whole), each with its end mark. */
function clauses(message: string): string[] {
  return (message.match(/[^.!?;\n]+(?:[.!?;]+|$)/g) ?? [])
    .flatMap((part) => part.split(/,\s+/))
    .map((c) => c.trim())
    .filter(Boolean);
}

function statedIn(clause: string, setting: ChatSetting): boolean {
  if (!FIELD_WORDS[setting.field].test(clause)) return false;
  if (HYPOTHETICAL.test(clause)) return false;
  if (/\?\s*$/.test(clause) && !SET_VERB.test(clause)) return false;
  if (setting.field === "target_roas" && /\bstretch\b/i.test(clause)) return false;
  if (PLAN_FIELDS.has(setting.field) && PLAN_ASK.test(clause)) return false;
  if (setting.field === "website_url" && SITE_LOOKUP.test(clause)) return false;
  if ("category" in setting && !clause.toLowerCase().includes(setting.category.toLowerCase())) return false;
  return true;
}

/** The LLM's JSON → settings: malformed items are dropped, and so is anything the message doesn't plainly state. */
export function parseSettingsReply(reply: string, message: string): ChatSetting[] {
  const json = reply.match(/\{[\s\S]*\}/);
  if (!json) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(json[0]);
  } catch {
    return [];
  }
  const items = raw && typeof raw === "object" && Array.isArray((raw as { settings?: unknown }).settings)
    ? ((raw as { settings: unknown[] }).settings)
    : [];
  const parts = clauses(message);
  const out: ChatSetting[] = [];
  for (const item of items) {
    const parsed = chatSettingSchema.safeParse(item);
    if (parsed.success && parts.some((c) => statedIn(c, parsed.data))) out.push(parsed.data);
  }
  return out;
}

const EXTRACT_SYSTEM = [
  "You read one message an ad agency operator typed about a client and pull out the client settings it clearly STATES or SETS as the client's standing value.",
  'Return ONLY JSON: {"settings":[...]}, with each item one of:',
  '{"field":"target_roas","value":8} (a ROAS multiple: 8x or 800% is 8)',
  '{"field":"gross_margin_pct","value":40} (the whole business\'s gross margin, percent)',
  '{"field":"average_value","value":189} (average order or lead value, in major currency units)',
  '{"field":"target_cpa","value":60}',
  '{"field":"daily_account_cap","value":1200}',
  '{"field":"monthly_cap","value":30000}',
  '{"field":"budget_ceiling","value":10000}',
  `{"field":"business_model","value":one of ${BUSINESS_MODELS.map((m) => `"${m}"`).join(", ")}}`,
  `{"field":"attribution","value":one of ${ATTRIBUTION_SETTINGS.map((m) => `"${m}"`).join(", ")}}`,
  '{"field":"industry","value":"Furniture"}',
  '{"field":"website_url","value":"https://example.com"}',
  '{"field":"business_description","value":"..."}',
  '{"field":"standing_instruction","value":"Always exclude NZ"} (a rule the agency must always or never follow)',
  '{"field":"allowed_countries","value":["AU","NZ"]} (ISO 3166-1 alpha-2 codes)',
  '{"field":"category_margin","category":"bar stools","value":45} (one product category\'s or service\'s margin)',
  '{"field":"category_average_value","category":"bar stools","value":189}',
  "Leave out: questions (\"what's our margin?\"), hypotheticals (\"what if we tried 15x\"), stretch targets, and the budget or target of a plan or strategy request (\"plan to hit 10x on $500/day\", \"$4k over 30 days\") — those are not settings.",
  '"$30k" means 30000. When unsure, leave the setting out. Return {"settings":[]} when there are none. No markdown.',
].join("\n");

/**
 * Settings the message states. Gated by `mentionsSettings`; needs an OpenAI key.
 * Never throws: without a key, or when the call or its JSON fails, nothing.
 */
export async function extractChatSettings(message: string): Promise<ChatSetting[]> {
  if (!mentionsSettings(message)) return [];
  const config = getConfig();
  if (!config.hasOpenAI || !config.OPENAI_API_KEY) return [];
  try {
    const { generateText } = await import("ai");
    const { createOpenAI } = await import("@ai-sdk/openai");
    const openai = createOpenAI({ apiKey: config.OPENAI_API_KEY });
    const { text: reply } = await generateText({
      model: openai(config.OPENAI_MODEL),
      temperature: 0,
      maxOutputTokens: 500,
      system: EXTRACT_SYSTEM,
      prompt: message.slice(0, 4000),
    });
    return parseSettingsReply(reply, message);
  } catch (error) {
    logger.warn("Chat settings: extraction failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

// ---------------------------------------------------------------------------
// Fields: where each is stored, how it reads, and why a value can fail.

type GoalsKey = "target_roas" | "gross_margin_pct" | "average_value_cents" | "target_cpa_cents" | "daily_account_cap_cents" | "monthly_cap_cents" | "business_model" | "attribution" | "allowed_countries";
type ClientKey = "budget_ceiling_cents" | "industry" | "website_url" | "business_description" | "standing_instructions";
type ServiceKey = "gross_margin_pct" | "average_order_value_cents";

type Target =
  | { kind: "goals"; key: GoalsKey }
  | { kind: "client"; key: ClientKey }
  | { kind: "service"; key: ServiceKey };

type Format = "roas" | "pct" | "money" | "text" | "model" | "attribution" | "countries";

const FIELDS: Record<Exclude<ChatSetting["field"], "category_margin" | "category_average_value">, { label: string; target: Exclude<Target, { kind: "service" }>; format: Format; reason: string }> = {
  target_roas: { label: "target ROAS", target: { kind: "goals", key: "target_roas" }, format: "roas", reason: "must be more than 0 and at most 100" },
  gross_margin_pct: { label: "margin", target: { kind: "goals", key: "gross_margin_pct" }, format: "pct", reason: "must be 0–100" },
  average_value: { label: "average order value", target: { kind: "goals", key: "average_value_cents" }, format: "money", reason: "must be more than 0" },
  target_cpa: { label: "target CPA", target: { kind: "goals", key: "target_cpa_cents" }, format: "money", reason: "must be more than 0" },
  daily_account_cap: { label: "daily account cap", target: { kind: "goals", key: "daily_account_cap_cents" }, format: "money", reason: "must be more than 0" },
  monthly_cap: { label: "monthly cap", target: { kind: "goals", key: "monthly_cap_cents" }, format: "money", reason: "must be more than 0" },
  budget_ceiling: { label: "budget ceiling", target: { kind: "client", key: "budget_ceiling_cents" }, format: "money", reason: "can't be negative" },
  business_model: { label: "business model", target: { kind: "goals", key: "business_model" }, format: "model", reason: "isn't a business model the Settings tab offers" },
  attribution: { label: "attribution", target: { kind: "goals", key: "attribution" }, format: "attribution", reason: "isn't an attribution setting the Settings tab offers" },
  allowed_countries: { label: "allowed countries", target: { kind: "goals", key: "allowed_countries" }, format: "countries", reason: "use 2-letter country codes" },
  industry: { label: "industry", target: { kind: "client", key: "industry" }, format: "text", reason: "must be text" },
  website_url: { label: "website", target: { kind: "client", key: "website_url" }, format: "text", reason: "must be a full web address, like https://example.com" },
  business_description: { label: "business description", target: { kind: "client", key: "business_description" }, format: "text", reason: "must be 4,000 characters or fewer" },
  standing_instruction: { label: "standing instructions", target: { kind: "client", key: "standing_instructions" }, format: "text", reason: "must be 4,000 characters or fewer in all" },
};

const ATTRIBUTION_TEXT: Record<string, string> = {
  "7d_click_1d_view": "7-day click, 1-day view",
  "7d_click": "7-day click",
  "1d_click": "1-day click",
};

function formatMoney(cents: number, currency: string): string {
  const whole = cents % 100 === 0;
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency,
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: whole ? 0 : 2,
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(whole ? 0 : 2)} ${currency}`;
  }
}

function formatValue(value: unknown, format: Format, currency: string): string {
  if (value == null || value === "") return "not set";
  switch (format) {
    case "roas":
      return `${value}×`;
    case "pct":
      return `${value}%`;
    case "money":
      return typeof value === "number" ? formatMoney(value, currency) : String(value);
    case "model":
      return String(value).replace(/_/g, " ");
    case "attribution":
      return ATTRIBUTION_TEXT[String(value)] ?? String(value);
    case "countries":
      return Array.isArray(value) ? value.join(", ") : String(value);
    case "text": {
      const s = String(value).replace(/\s+/g, " ").trim();
      return /^https?:\/\//i.test(s) ? s : `"${s.length > 80 ? `${s.slice(0, 77)}…` : s}"`;
    }
  }
}

/** Is `schema` happy with { key: value }? */
function valid(target: Target, value: unknown): boolean {
  const body = { [target.key]: value };
  if (target.kind === "goals") return goalsProfileSchema.safeParse(body).success;
  if (target.kind === "client") return clientPatchSchema.safeParse(body).success;
  return servicePatchSchema.safeParse(body).success;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function possessive(name: string): string {
  return /s$/i.test(name.trim()) ? `${name.trim()}'` : `${name.trim()}'s`;
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

// ---------------------------------------------------------------------------
// Stores

/** The turn user's role, from profiles; anyone unknown is not an admin. */
async function userIsAdmin(userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    return isAdmin(getDemoStore().profiles.find((p) => p.id === userId) ?? null);
  }
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { data } = await createAdminClient().from("profiles").select("role").eq("id", userId).maybeSingle();
  return isAdmin((data as Pick<Profile, "role"> | null) ?? null);
}

async function loadClient(clientId: string): Promise<Client> {
  const { getClient } = await import("@/lib/approvals/service");
  return getClient(clientId);
}

type ClientPatch = Partial<Pick<Client, ClientKey>> & { goals_profile?: GoalsProfile };

async function writeClient(clientId: string, patch: ClientPatch): Promise<void> {
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    const store = getDemoStore();
    const idx = store.clients.findIndex((c) => c.id === clientId);
    if (idx < 0) throw new Error(`Client not found: ${clientId}`);
    store.clients[idx] = { ...store.clients[idx], ...patch, updated_at: nowIso() };
    return;
  }
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { error } = await createAdminClient()
    .from("clients")
    .update({ ...toClientDbPatch(patch), updated_at: nowIso() })
    .eq("id", clientId)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
}

async function writeService(clientId: string, serviceId: string, patch: Partial<ClientService>): Promise<void> {
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    const row = getDemoStore().clientServices.find((s) => s.id === serviceId && s.client_id === clientId);
    if (!row) throw new Error("Service not found");
    Object.assign(row, patch, { updated_at: nowIso() });
    return;
  }
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { error } = await createAdminClient()
    .from("client_services")
    .update(patch)
    .eq("id", serviceId)
    .eq("client_id", clientId)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
}

// ---------------------------------------------------------------------------
// The turn

export type SettingChange = { field: string; before: unknown; after: unknown };

export type SettingsToolCall = {
  name: "update_client_settings";
  args: { changes: SettingChange[] };
  rationale: string;
};

/** One value checked and ready to save (or to use for this turn only). */
type Planned = {
  target: Target;
  service?: ClientService;
  before: unknown;
  after: unknown;
  /** "target ROAS 10×", "Bar Stools margin 45%". */
  text: string;
  format: Format;
};

export type ChatSettingsTurn = {
  /** Profile values stated this turn (saved or not), for planning on them now. */
  goalsOverride(): GoalsProfile;
  /** The services with this turn's category values applied. */
  withServiceOverrides(services: ClientService[]): ClientService[];
  /** Applies category settings still waiting for their category (e.g. one added from the question). */
  applyPendingCategories(services: ClientService[]): Promise<void>;
  /** Saves a whole-account strategy ask's target ROAS, unless this turn already stated one. */
  saveStrategyTarget(targetRoas: number): Promise<void>;
  /** The evidence section for the writer, or null when there is nothing to say. */
  evidence(): string | null;
  /** The audit record of what was saved, or null when nothing was. */
  toolCall(): SettingsToolCall | null;
};

/**
 * Reads the settings the request states and saves them (admins only), before
 * the turn's plan is built. Never throws: a failure is logged and reported.
 */
export async function applyChatSettings(input: {
  clientId: string;
  userId?: string | null;
  request: string;
  /** The client's active services, for matching a category by name. */
  services: ClientService[];
}): Promise<ChatSettingsTurn> {
  const { clientId, userId } = input;
  let context: Promise<{ client: Client; admin: boolean }> | null = null;
  const load = () => {
    context ??= Promise.all([loadClient(clientId), userIsAdmin(userId).catch(() => false)]).then(([client, admin]) => ({
      client,
      admin,
    }));
    return context;
  };

  const saved: Array<SettingChange & { text: string; format: Format }> = [];
  const turnOnly: string[] = [];
  const notSaved: string[] = [];
  const failed: string[] = [];
  let pending: CategorySetting[] = [];
  let statedTarget = false;
  let clientName = "the client";
  let categoryWord = "category";
  let currency = "USD";
  const goals: GoalsProfile = {};
  const clientValues: Partial<Pick<Client, ClientKey>> = {};
  const serviceValues = new Map<string, Partial<ClientService>>();

  const fieldName = (p: Planned) =>
    p.target.kind === "goals"
      ? `goals_profile.${p.target.key}`
      : p.target.kind === "client"
        ? p.target.key
        : `services.${p.service!.name}.${p.target.key}`;

  /** Checks one setting against the Settings rules; a category not matched yet waits. */
  function plan(setting: ChatSetting, client: Client, services: ClientService[]): Planned | "pending" | null {
    if (setting.field === "category_margin" || setting.field === "category_average_value") {
      const categories = categoriesFromServices(services);
      const singular = setting.category.replace(/s$/i, "");
      const match =
        matchCategoryByLabel(setting.category, categories) ??
        (singular !== setting.category ? matchCategoryByLabel(singular, categories) : null);
      if (!match) return "pending";
      const service = services.find((s) => s.id === match.id)!;
      const margin = setting.field === "category_margin";
      const target: Target = { kind: "service", key: margin ? "gross_margin_pct" : "average_order_value_cents" };
      const after = margin ? setting.value : Math.round(setting.value * 100);
      const format: Format = margin ? "pct" : "money";
      const label = `${service.name} ${margin ? "margin" : "average order value"}`;
      const text = `${label} ${formatValue(after, format, currency)}`;
      if (!valid(target, after)) {
        notSaved.push(`Didn't save ${text}: ${margin ? "must be 0–100" : "can't be negative"}.`);
        return null;
      }
      const before = serviceValues.get(service.id)?.[target.key] ?? service[target.key] ?? null;
      return { target, service, before, after, text, format };
    }

    const spec = FIELDS[setting.field];
    const { target } = spec;
    let after: unknown = setting.value;
    if (MONEY_FIELDS.includes(setting.field as MoneyField)) after = Math.round((setting.value as number) * 100);
    if (setting.field === "website_url") {
      const url = String(setting.value);
      after = /^https?:\/\//i.test(url) || !/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(url) ? url : `https://${url}`;
    }
    let before: unknown =
      target.kind === "goals"
        ? (goals[target.key] ?? client.goals_profile?.[target.key] ?? null)
        : (clientValues[target.key] ?? client[target.key] ?? null);
    let text = `${spec.label} ${formatValue(after, spec.format, currency)}`;
    if (setting.field === "standing_instruction") {
      const rule = String(setting.value);
      const existing = typeof before === "string" ? before : "";
      if (existing.toLowerCase().includes(rule.toLowerCase())) return null;
      after = existing ? `${existing.trimEnd()}\n${rule}` : rule;
      text = `standing instruction ${formatValue(rule, "text", currency)}`;
      before = existing || null;
    }
    if (!valid(target, after)) {
      notSaved.push(`Didn't save ${text}: ${spec.reason}.`);
      return null;
    }
    if (sameValue(before, after)) return null;
    return { target, before, after, text, format: spec.format };
  }

  /** A save that failed: logged, and reported to the writer. */
  const failure = (what: string, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Chat settings: couldn't save", { clientId, what, error: message });
    failed.push(`Couldn't save ${what} (${message}).`);
  };

  async function apply(settings: ChatSetting[], services: ClientService[]): Promise<void> {
    if (!settings.length) return;
    try {
      const { client, admin } = await load();
      clientName = client.name;
      categoryWord = client.goals_profile?.business_model === "ecommerce" ? "category" : "service";
      currency = client.currency || "USD";
      // Re-read so every save merges onto the latest profile.
      const fresh = admin && saved.length ? await loadClient(clientId) : client;
      const planned: Planned[] = [];
      for (const setting of settings) {
        const result = plan(setting, fresh, services);
        if (result === "pending") pending.push(setting as CategorySetting);
        else if (result) planned.push(result);
      }
      if (!planned.length) return;

      // Values for this turn, saved or not.
      for (const p of planned) {
        if (p.target.kind === "goals") Object.assign(goals, { [p.target.key]: p.after });
        if (p.target.kind === "client") Object.assign(clientValues, { [p.target.key]: p.after });
        if (p.target.kind === "service") {
          serviceValues.set(p.service!.id, { ...serviceValues.get(p.service!.id), [p.target.key]: p.after });
        }
      }
      if (!admin) {
        turnOnly.push(...planned.map((p) => p.text));
        return;
      }

      const clientSide = planned.filter((p) => p.target.kind !== "service");
      if (clientSide.length) {
        const patch: ClientPatch = {};
        for (const p of clientSide) {
          if (p.target.kind === "goals") {
            patch.goals_profile = { ...(patch.goals_profile ?? fresh.goals_profile ?? {}), [p.target.key]: p.after };
          } else {
            Object.assign(patch, { [p.target.key]: p.after });
          }
        }
        try {
          await writeClient(clientId, patch);
          for (const p of clientSide) saved.push({ field: fieldName(p), before: p.before, after: p.after, text: p.text, format: p.format });
        } catch (error) {
          failure(joinList(clientSide.map((p) => p.text)), error);
        }
      }
      for (const p of planned.filter((x) => x.target.kind === "service")) {
        try {
          await writeService(clientId, p.service!.id, { [p.target.key]: p.after });
          saved.push({ field: fieldName(p), before: p.before, after: p.after, text: p.text, format: p.format });
        } catch (error) {
          failure(p.text, error);
        }
      }
    } catch (error) {
      failure("the settings in this message", error);
    }
  }

  const extracted = await extractChatSettings(input.request);
  statedTarget = extracted.some((s) => s.field === "target_roas");
  await apply(extracted, input.services);

  const summary = () =>
    `Saved to ${possessive(clientName)} settings: ${saved
      .map((s) => `${s.text} (was ${formatValue(s.before, s.format, currency)})`)
      .join("; ")}.`;

  return {
    goalsOverride: () => ({ ...goals }),
    withServiceOverrides: (services) =>
      services.map((s) => (serviceValues.has(s.id) ? { ...s, ...serviceValues.get(s.id) } : s)),
    async applyPendingCategories(services) {
      if (!pending.length) return;
      const waiting = pending;
      pending = [];
      await apply(waiting, services);
    },
    async saveStrategyTarget(targetRoas) {
      if (statedTarget) return;
      statedTarget = true;
      await apply([{ field: "target_roas", value: targetRoas }], []);
    },
    evidence() {
      const lines: string[] = [];
      if (saved.length) lines.push(summary());
      if (turnOnly.length) {
        lines.push(`Only an admin can save client settings; I used ${joinList(turnOnly)} for this answer only.`);
      }
      lines.push(...notSaved, ...failed);
      for (const p of pending) {
        const margin = p.field === "category_margin";
        const value = margin ? `${p.value}%` : formatMoney(Math.round(p.value * 100), currency);
        lines.push(
          `Didn't save ${p.category} ${margin ? "margin" : "average order value"} ${value}: no ${categoryWord} called "${p.category}" is set up; add it on the Services tab.`,
        );
      }
      if (!lines.length) return null;
      return [
        "### Client settings from this message",
        ...lines.map((l) => `- ${l}`),
        "Repeat the lines above to the user exactly, near the top of the reply.",
      ].join("\n");
    },
    toolCall() {
      if (!saved.length) return null;
      return {
        name: "update_client_settings",
        args: { changes: saved.map(({ field, before, after }) => ({ field, before, after })) },
        rationale: summary(),
      };
    },
  };
}
