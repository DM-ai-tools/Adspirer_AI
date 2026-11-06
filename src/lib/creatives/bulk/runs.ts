import { nanoid } from "nanoid";
import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import type { ImageFormat } from "@/lib/creatives/formats";
import type { BulkBody, BulkCta, MessageMap } from "@/lib/creatives/bulk/plan";

/** An earlier look of an image, kept when it is edited so the edit can be undone. */
export type ImageVersion = { id: string; key: string; at: string; instruction: string; mode: "edit" | "full" };

export type RunItem = {
  draft_id: string;
  angle_key: string | null;
  angle_name: string | null;
  stage: string | null;
  kind: string | null;
  targets: string | null;
  body_id: string | null;
  cta_label: string | null;
  /** Earlier versions of this image, oldest first. */
  versions?: ImageVersion[];
  /** Why the last edit failed, if it did. */
  edit_error?: string | null;
};

export type RunStatus = "planning" | "rendering" | "done" | "failed";

export type CreativeRun = {
  id: string;
  client_id: string;
  service_id: string | null;
  created_by: string | null;
  landing_page_url: string | null;
  inputs: { notes?: string | null; pastedCopy?: string | null; brandUrl?: string | null };
  image_format: ImageFormat;
  status: RunStatus;
  error: string | null;
  message_map: MessageMap | null;
  bodies: BulkBody[] | null;
  ctas: BulkCta[] | null;
  items: RunItem[];
  lease_until: string | null;
  created_at: string;
  updated_at: string;
};

/** How long one worker owns a run's rendering. A little over the longest route. */
export const LEASE_MS = 290_000;

function memory(): CreativeRun[] {
  const store = getDemoStore() as ReturnType<typeof getDemoStore> & { creativeRuns?: CreativeRun[] };
  if (!store.creativeRuns) store.creativeRuns = [];
  return store.creativeRuns;
}

function useMemory(): boolean {
  const config = getConfig();
  return config.isDemoMode || !config.hasSupabase;
}

async function admin() {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  return createAdminClient();
}

function mapRow(row: Record<string, unknown>): CreativeRun {
  return {
    id: String(row.id),
    client_id: String(row.client_id),
    service_id: (row.service_id as string | null) ?? null,
    created_by: (row.created_by as string | null) ?? null,
    landing_page_url: (row.landing_page_url as string | null) ?? null,
    inputs: (row.inputs as CreativeRun["inputs"]) ?? {},
    image_format: ((row.image_format as ImageFormat) ?? "4:5") as ImageFormat,
    status: ((row.status as RunStatus) ?? "planning") as RunStatus,
    error: (row.error as string | null) ?? null,
    message_map: (row.message_map as MessageMap | null) ?? null,
    bodies: (row.bodies as BulkBody[] | null) ?? null,
    ctas: (row.ctas as BulkCta[] | null) ?? null,
    items: Array.isArray(row.items) ? (row.items as RunItem[]) : [],
    lease_until: (row.lease_until as string | null) ?? null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function failMissingTable(error: { code?: string; message?: string }): never {
  if (error.code === "PGRST205" || error.code === "42P01" || /creative_runs/i.test(error.message ?? "")) {
    throw new Error("Bulk runs need migration 00017_creative_runs.sql to be applied first.");
  }
  throw new Error(error.message ?? "Could not read bulk runs");
}

export async function createRun(input: {
  clientId: string;
  serviceId?: string | null;
  createdBy?: string | null;
  landingPageUrl?: string | null;
  inputs: CreativeRun["inputs"];
  format: ImageFormat;
}): Promise<CreativeRun> {
  const now = new Date().toISOString();
  const run: CreativeRun = {
    id: `run_${nanoid(12)}`,
    client_id: input.clientId,
    service_id: input.serviceId ?? null,
    created_by: input.createdBy ?? null,
    landing_page_url: input.landingPageUrl ?? null,
    inputs: input.inputs,
    image_format: input.format,
    status: "planning",
    error: null,
    message_map: null,
    bodies: null,
    ctas: null,
    items: [],
    lease_until: null,
    created_at: now,
    updated_at: now,
  };
  if (useMemory()) {
    memory().push(run);
    return run;
  }
  const { error } = await (await admin()).from("creative_runs").insert(run);
  if (error) failMissingTable(error);
  return run;
}

export async function getRun(id: string): Promise<CreativeRun | null> {
  if (useMemory()) return memory().find((r) => r.id === id) ?? null;
  const { data, error } = await (await admin()).from("creative_runs").select("*").eq("id", id).maybeSingle();
  if (error) failMissingTable(error);
  return data ? mapRow(data as Record<string, unknown>) : null;
}

export async function listRuns(clientId: string, limit = 40): Promise<CreativeRun[]> {
  if (useMemory()) {
    return memory()
      .filter((r) => r.client_id === clientId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit);
  }
  const { data, error } = await (await admin())
    .from("creative_runs")
    .select("*")
    .eq("client_id", clientId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) failMissingTable(error);
  return (data ?? []).map((r) => mapRow(r as Record<string, unknown>));
}

export async function updateRun(id: string, patch: Partial<Omit<CreativeRun, "id" | "client_id" | "created_at">>): Promise<CreativeRun> {
  const now = new Date().toISOString();
  if (useMemory()) {
    const run = memory().find((r) => r.id === id);
    if (!run) throw new Error("Run not found");
    Object.assign(run, patch, { updated_at: now });
    return run;
  }
  const { data, error } = await (await admin())
    .from("creative_runs")
    .update({ ...patch, updated_at: now })
    .eq("id", id)
    .select("*")
    .single();
  if (error) failMissingTable(error);
  return mapRow(data as Record<string, unknown>);
}

/**
 * Take the run's render lease if nobody holds it. Returns false when another worker has it, so two
 * requests never render the same drafts. The check-and-set is one conditional update.
 */
export async function claimLease(id: string): Promise<boolean> {
  const now = new Date();
  const until = new Date(now.getTime() + LEASE_MS).toISOString();
  if (useMemory()) {
    const run = memory().find((r) => r.id === id);
    if (!run) return false;
    if (run.lease_until && run.lease_until > now.toISOString()) return false;
    run.lease_until = until;
    return true;
  }
  const { data, error } = await (await admin())
    .from("creative_runs")
    .update({ lease_until: until })
    .eq("id", id)
    .or(`lease_until.is.null,lease_until.lt.${now.toISOString()}`)
    .select("id");
  if (error) failMissingTable(error);
  return (data?.length ?? 0) > 0;
}

export async function releaseLease(id: string): Promise<void> {
  await updateRun(id, { lease_until: null }).catch(() => undefined);
}

export function leaseActive(run: CreativeRun, now = Date.now()): boolean {
  return Boolean(run.lease_until && new Date(run.lease_until).getTime() > now);
}
