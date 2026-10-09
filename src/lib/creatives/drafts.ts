import { nanoid } from "nanoid";
import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { logger } from "@/lib/observability/logger";
import { nowIso } from "@/lib/utils";

export type CreativeDraftStatus =
  | "draft"
  | "generating"
  | "ready"
  | "selected"
  | "revised"
  | "rejected"
  | "failed";

export type CreativeImageStatus =
  | "pending"
  | "generating"
  | "succeeded"
  | "failed"
  | "skipped";

export type CreativeDraft = {
  id: string;
  client_id: string;
  service_id: string | null;
  conversation_id: string | null;
  task_id: string | null;
  brief_id: string | null;
  concept: string;
  headline: string;
  primary_text: string;
  description: string | null;
  cta: string | null;
  creative_direction: string | null;
  /**
   * The three fields below are `undefined` when the row was read without
   * them (list/card queries skip them — `image_b64` alone can be several MB).
   * Writes leave undefined columns untouched instead of nulling them.
   */
  image_url?: string | null;
  image_b64?: string | null;
  image_mime: string;
  image_model: string | null;
  image_prompt?: string | null;
  image_status: CreativeImageStatus;
  image_error: string | null;
  landing_page_url: string | null;
  brand_colors: string[] | null;
  logo_url: string | null;
  status: CreativeDraftStatus;
  revision_notes: string | null;
  created_at: string;
  updated_at: string;
};

type UpsertInput = Omit<
  CreativeDraft,
  "id" | "created_at" | "updated_at" | "status" | "image_status" | "image_error"
> & {
  id?: string;
  status?: CreativeDraftStatus;
  image_status?: CreativeImageStatus;
  image_error?: string | null;
};

type DraftFilters = { conversationId?: string; taskId?: string };

/** Column value, or undefined when the query did not select it. */
function loaded(row: Record<string, unknown>, key: string): string | null | undefined {
  return key in row ? ((row[key] as string | null) ?? null) : undefined;
}

function mapRow(row: Record<string, unknown>): CreativeDraft {
  return {
    id: String(row.id),
    client_id: String(row.client_id),
    service_id: (row.service_id as string | null) ?? null,
    conversation_id: (row.conversation_id as string | null) ?? null,
    task_id: (row.task_id as string | null) ?? null,
    brief_id: (row.brief_id as string | null) ?? null,
    concept: String(row.concept),
    headline: String(row.headline),
    primary_text: String(row.primary_text),
    description: (row.description as string | null) ?? null,
    cta: (row.cta as string | null) ?? null,
    creative_direction: (row.creative_direction as string | null) ?? null,
    image_url: loaded(row, "image_url"),
    image_b64: loaded(row, "image_b64"),
    image_mime: String(row.image_mime ?? "image/png"),
    image_model: (row.image_model as string | null) ?? null,
    image_prompt: loaded(row, "image_prompt"),
    image_status: (row.image_status as CreativeImageStatus) ?? "pending",
    image_error: (row.image_error as string | null) ?? null,
    landing_page_url: (row.landing_page_url as string | null) ?? null,
    brand_colors: Array.isArray(row.brand_colors)
      ? (row.brand_colors as string[])
      : null,
    logo_url: (row.logo_url as string | null) ?? null,
    status: (row.status as CreativeDraftStatus) ?? "draft",
    revision_notes: (row.revision_notes as string | null) ?? null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function toRow(draft: CreativeDraft): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: draft.id,
    client_id: draft.client_id,
    service_id: draft.service_id,
    conversation_id: draft.conversation_id,
    task_id: draft.task_id,
    brief_id: draft.brief_id,
    concept: draft.concept,
    headline: draft.headline,
    primary_text: draft.primary_text,
    description: draft.description,
    cta: draft.cta,
    creative_direction: draft.creative_direction,
    image_url: draft.image_url,
    image_b64: draft.image_b64,
    image_mime: draft.image_mime,
    image_model: draft.image_model,
    image_prompt: draft.image_prompt,
    image_status: draft.image_status,
    image_error: draft.image_error,
    landing_page_url: draft.landing_page_url,
    brand_colors: draft.brand_colors,
    logo_url: draft.logo_url,
    status: draft.status,
    revision_notes: draft.revision_notes,
    created_at: draft.created_at,
    updated_at: draft.updated_at,
  };
  // Never write a column we didn't load — that used to wipe sibling drafts'
  // images whenever one creative was selected.
  for (const key of Object.keys(row)) {
    if (row[key] === undefined) delete row[key];
  }
  return row;
}

function memoryStore(): CreativeDraft[] {
  const store = getDemoStore() as ReturnType<typeof getDemoStore> & {
    creativeDrafts?: CreativeDraft[];
  };
  if (!store.creativeDrafts) store.creativeDrafts = [];
  return store.creativeDrafts;
}

/**
 * The creative_drafts table ships in migration 00003. Projects that have not
 * applied it yet keep working against the in-process store instead of failing
 * every Creatives request.
 */
let tableMissing = false;

function isMissingTableError(error: unknown): boolean {
  const err = error as { code?: string; message?: string } | null;
  const message = err?.message ?? "";
  return (
    err?.code === "PGRST205" ||
    err?.code === "42P01" ||
    /creative_drafts.*(schema cache|does not exist)/i.test(message)
  );
}

function markTableMissing(error: unknown): void {
  if (!tableMissing) {
    tableMissing = true;
    logger.warn("creative_drafts table not found; using in-memory drafts", {
      hint: "Apply supabase/migrations/00003_creative_drafts.sql",
      error: (error as { message?: string })?.message,
    });
  }
}

function shouldUseMemoryStore(): boolean {
  const config = getConfig();
  return config.isDemoMode || !config.hasSupabase || tableMissing;
}

async function adminClient() {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  return createAdminClient();
}

/**
 * Card/list columns only. `image_b64` is a multi-MB still and `image_url` is
 * often the same bytes as a `data:` URI — `select("*")` on those is why
 * `/api/creatives/status` took tens of seconds. Cards always go through
 * `/api/creatives/assets/:id` when there is no short https URL.
 */
const CARD_COLUMNS =
  "id,client_id,service_id,conversation_id,task_id,brief_id,concept,headline,primary_text,description,cta,creative_direction,image_mime,image_model,image_status,image_error,landing_page_url,brand_colors,logo_url,status,revision_notes,created_at,updated_at";

/** One-row lookups that need the hosted URL (Cloudinary) but not the base64. */
const SELECTED_COLUMNS = `${CARD_COLUMNS},image_url`;

function filterMemoryDrafts(
  clientId: string,
  filters?: DraftFilters,
): CreativeDraft[] {
  return memoryStore()
    .filter((d) => d.client_id === clientId)
    .filter((d) =>
      filters?.conversationId
        ? d.conversation_id === filters.conversationId
        : true,
    )
    .filter((d) => (filters?.taskId ? d.task_id === filters.taskId : true))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

function writeMemoryDraft(draft: CreativeDraft): CreativeDraft {
  const store = memoryStore();
  const idx = store.findIndex((d) => d.id === draft.id);
  if (idx >= 0) store[idx] = draft;
  else store.unshift(draft);
  return draft;
}

export async function listCreativeDraftsAsync(
  clientId: string,
  filters?: DraftFilters,
): Promise<CreativeDraft[]> {
  if (shouldUseMemoryStore()) return filterMemoryDrafts(clientId, filters);

  const supabase = await adminClient();
  let query = supabase
    .from("creative_drafts")
    .select(CARD_COLUMNS)
    .eq("client_id", clientId);
  if (filters?.conversationId) {
    query = query.eq("conversation_id", filters.conversationId);
  }
  if (filters?.taskId) {
    query = query.eq("task_id", filters.taskId);
  }
  const { data, error } = await query.order("updated_at", { ascending: false });
  if (error) {
    if (isMissingTableError(error)) {
      markTableMissing(error);
      return filterMemoryDrafts(clientId, filters);
    }
    throw new Error(error.message);
  }
  return (data ?? []).map((row) => mapRow(row as Record<string, unknown>));
}

/**
 * One draft. Skips the inline image bytes unless `withImageData` is set —
 * only the asset route and the Cloudinary upload need them.
 */
export async function getCreativeDraftAsync(
  id: string,
  options?: { withImageData?: boolean },
): Promise<CreativeDraft | null> {
  if (shouldUseMemoryStore()) {
    return memoryStore().find((d) => d.id === id) ?? null;
  }

  const columns: string = options?.withImageData
    ? "*"
    : `${SELECTED_COLUMNS},image_prompt`;
  const supabase = await adminClient();
  const { data, error } = await supabase
    .from("creative_drafts")
    .select(columns)
    .eq("id", id)
    .maybeSingle();
  if (error) {
    if (isMissingTableError(error)) {
      markTableMissing(error);
      return memoryStore().find((d) => d.id === id) ?? null;
    }
    throw new Error(error.message);
  }
  return data ? mapRow(data as unknown as Record<string, unknown>) : null;
}

function mergeDraft(
  input: UpsertInput,
  existing: CreativeDraft | null,
): CreativeDraft {
  const ts = nowIso();
  if (existing) {
    // Spread only fields the caller actually set; `undefined` means "unchanged".
    const changes = Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    ) as UpsertInput;
    return {
      ...existing,
      ...changes,
      id: existing.id,
      created_at: existing.created_at,
      updated_at: ts,
      status: input.status ?? existing.status,
      image_status: input.image_status ?? existing.image_status,
      image_error:
        input.image_error !== undefined
          ? input.image_error
          : existing.image_error,
    };
  }
  return {
    id: input.id ?? `crd_${nanoid(12)}`,
    client_id: input.client_id,
    service_id: input.service_id ?? null,
    conversation_id: input.conversation_id ?? null,
    task_id: input.task_id ?? null,
    brief_id: input.brief_id ?? null,
    concept: input.concept,
    headline: input.headline,
    primary_text: input.primary_text,
    description: input.description ?? null,
    cta: input.cta ?? null,
    creative_direction: input.creative_direction ?? null,
    image_url: input.image_url ?? null,
    image_b64: input.image_b64 ?? null,
    image_mime: input.image_mime || "image/png",
    image_model: input.image_model ?? null,
    image_prompt: input.image_prompt ?? null,
    image_status: input.image_status ?? "pending",
    image_error: input.image_error ?? null,
    landing_page_url: input.landing_page_url ?? null,
    brand_colors: input.brand_colors ?? null,
    logo_url: input.logo_url ?? null,
    status: input.status ?? "draft",
    revision_notes: input.revision_notes ?? null,
    created_at: ts,
    updated_at: ts,
  };
}

export async function upsertCreativeDraftAsync(
  input: UpsertInput,
): Promise<CreativeDraft> {
  // Light read: heavy columns stay undefined and are therefore not rewritten.
  const existing = input.id ? await getCreativeDraftAsync(input.id) : null;
  const draft = mergeDraft(input, existing);

  if (shouldUseMemoryStore()) return writeMemoryDraft(draft);

  const supabase = await adminClient();
  const { error } = await supabase.from("creative_drafts").upsert(toRow(draft));
  if (error) {
    if (isMissingTableError(error)) {
      markTableMissing(error);
      return writeMemoryDraft(draft);
    }
    throw new Error(error.message);
  }
  return draft;
}

export async function selectCreativeDraftAsync(
  id: string,
): Promise<CreativeDraft | null> {
  const draft = await getCreativeDraftAsync(id);
  if (!draft) return null;

  const siblings = await listCreativeDraftsAsync(draft.client_id);
  for (const sibling of siblings) {
    if (sibling.id !== id && sibling.status === "selected") {
      await upsertCreativeDraftAsync({ ...sibling, status: "draft" });
    }
  }
  return upsertCreativeDraftAsync({ ...draft, status: "selected" });
}

export async function rejectCreativeDraftAsync(
  id: string,
): Promise<CreativeDraft | null> {
  const draft = await getCreativeDraftAsync(id);
  if (!draft) return null;
  return upsertCreativeDraftAsync({ ...draft, status: "rejected" });
}

/**
 * Pass `conversationId` when the answer will be used as a default for new work:
 * a creative picked for a previous campaign must not silently attach itself to
 * the next one.
 */
export async function getSelectedCreativeDraftAsync(
  clientId: string,
  filters?: { conversationId?: string | null },
): Promise<CreativeDraft | null> {
  const conversationId = filters?.conversationId;

  if (shouldUseMemoryStore()) {
    return (
      memoryStore().find(
        (d) =>
          d.client_id === clientId &&
          d.status === "selected" &&
          (conversationId === undefined ||
            d.conversation_id === conversationId),
      ) ?? null
    );
  }

  const supabase = await adminClient();
  let query = supabase
    .from("creative_drafts")
    .select(SELECTED_COLUMNS)
    .eq("client_id", clientId)
    .eq("status", "selected");
  if (conversationId !== undefined) {
    query = conversationId
      ? query.eq("conversation_id", conversationId)
      : query.is("conversation_id", null);
  }
  const { data, error } = await query
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    if (isMissingTableError(error)) {
      markTableMissing(error);
      return getSelectedCreativeDraftAsync(clientId, filters);
    }
    throw new Error(error.message);
  }
  return data ? mapRow(data as Record<string, unknown>) : null;
}

export function publicCreativeAssetUrl(draftId: string): string {
  const config = getConfig();
  const base = (config.APP_URL || "http://localhost:3000").replace(/\/$/, "");
  return `${base}/api/creatives/assets/${draftId}`;
}

/**
 * True when the still is only available as inline data (base64/data URI) and
 * must be served through our asset route.
 */
function isInlineImage(
  draft: Pick<CreativeDraft, "image_b64" | "image_url">,
): boolean {
  return Boolean(draft.image_b64) || Boolean(draft.image_url?.startsWith("data:"));
}

function hostedHttpUrl(url: string | null | undefined): string | null {
  if (!url || url.startsWith("data:")) return null;
  return /^https?:\/\//i.test(url) ? url : null;
}

export function resolveImageUrlForAdspirer(draft: CreativeDraft): string | null {
  return hostedHttpUrl(draft.image_url) ?? (
    isInlineImage(draft) || draft.image_status === "succeeded"
      ? publicCreativeAssetUrl(draft.id)
      : (draft.image_url ?? null)
  );
}

/**
 * A still that has sat in "generating" this long is not coming back: the render
 * ran in a background job that died with its process (a dev restart, a deploy, a
 * crash). GPT Image takes 30–90s, so anything past this is stalled, and calling
 * it live left spinners running for days on every surface that reads a draft.
 */
const RENDER_STALL_MS = 10 * 60 * 1000;

export function isRenderStalled(
  draft: Pick<CreativeDraft, "image_status" | "updated_at">,
): boolean {
  if (draft.image_status !== "generating" && draft.image_status !== "pending") {
    return false;
  }
  const touched = Date.parse(draft.updated_at);
  if (Number.isNaN(touched)) return true;
  return Date.now() - touched > RENDER_STALL_MS;
}

export function toPublicDraft(draft: CreativeDraft) {
  // Reworks reuse the same asset id, so version the display URL to defeat
  // browser caching of the previous still.
  const hosted = hostedHttpUrl(draft.image_url);
  const displayUrl = hosted
    ? hosted.includes("/api/creatives/assets/")
      ? `${publicCreativeAssetUrl(draft.id)}?v=${encodeURIComponent(draft.updated_at)}`
      : hosted
    : isInlineImage(draft) || draft.image_status === "succeeded"
      ? `${publicCreativeAssetUrl(draft.id)}?v=${encodeURIComponent(draft.updated_at)}`
      : draft.image_url;
  const stalled = isRenderStalled(draft);
  return {
    id: draft.id,
    concept: draft.concept,
    headline: draft.headline,
    primary_text: draft.primary_text,
    description: draft.description,
    cta: draft.cta,
    creative_direction: draft.creative_direction,
    image_url: displayUrl,
    image_status: stalled ? ("failed" as CreativeImageStatus) : draft.image_status,
    image_error: stalled
      ? (draft.image_error ??
        "Generation stopped before this still finished — Rework to retry.")
      : draft.image_error,
    image_model: draft.image_model,
    status: draft.status,
    revision_notes: draft.revision_notes,
    brand_colors: draft.brand_colors,
    logo_url: draft.logo_url,
    created_at: draft.created_at,
    updated_at: draft.updated_at,
  };
}
