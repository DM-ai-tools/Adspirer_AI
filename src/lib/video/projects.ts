import { nanoid } from "nanoid";
import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import type { VideoScript } from "@/lib/video/script";
import type { AssetAnalysis } from "@/lib/video/assets";
import type { ScriptProgress } from "@/lib/video/progress";
import type { ClipState, GenerationPlan } from "@/lib/video/generation-types";

export type VideoAsset = {
  id: string;
  name: string;
  caption: string;
  role: "show" | "highlight";
  key: string;
  mime: string;
  /** What the image is and which stats it carries, read automatically. */
  analysis?: AssetAnalysis | null;
};

export type VideoInputs = {
  landingPageUrl?: string | null;
  instructions?: string | null;
  offerDetails?: string | null;
  stats: string[];
  targetSeconds: number;
  style: string;
  locale: string;
  format: "9:16" | "1:1" | "4:5";
  priority: "quality" | "balanced" | "cost";
};

export type VideoBrand = {
  name: string;
  colors: string[] | null;
  logoUrl: string | null;
  summary: string | null;
  /** What the scripts were written from, kept so a scene can be rewritten later without reading the site again. */
  facts?: string;
  corpus?: string;
};

export type VideoProjectStatus = "writing" | "scripts_ready" | "confirmed" | "generating" | "clips_ready" | "failed";

export type VideoProject = {
  id: string;
  client_id: string;
  service_id: string | null;
  created_by: string | null;
  inputs: VideoInputs;
  assets: VideoAsset[];
  brand: VideoBrand | null;
  status: VideoProjectStatus;
  error: string | null;
  scripts: VideoScript[] | null;
  chosen_script: VideoScript | null;
  /** Where the script writing is up to. Optional: needs the progress column from migration 00018. */
  progress?: ScriptProgress | null;
  /** The video being made: the plan and each clip's state. */
  plan?: GenerationPlan | null;
  clips?: ClipState[] | null;
  lease_until?: string | null;
  created_at: string;
  updated_at: string;
};

function memory(): VideoProject[] {
  const store = getDemoStore() as ReturnType<typeof getDemoStore> & { videoProjects?: VideoProject[] };
  if (!store.videoProjects) store.videoProjects = [];
  return store.videoProjects;
}

const useMemory = () => {
  const c = getConfig();
  return c.isDemoMode || !c.hasSupabase;
};

async function admin() {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  return createAdminClient();
}

function fail(error: { code?: string; message?: string }): never {
  if (error.code === "PGRST205" || error.code === "42P01" || /video_projects/i.test(error.message ?? "")) {
    throw new Error("Video ads need migration 00018_video_projects.sql to be applied first.");
  }
  throw new Error(error.message ?? "Could not read video projects");
}

function mapRow(row: Record<string, unknown>): VideoProject {
  return {
    id: String(row.id),
    client_id: String(row.client_id),
    service_id: (row.service_id as string | null) ?? null,
    created_by: (row.created_by as string | null) ?? null,
    inputs: (row.inputs as VideoInputs) ?? ({} as VideoInputs),
    assets: Array.isArray(row.assets) ? (row.assets as VideoAsset[]) : [],
    brand: (row.brand as VideoBrand | null) ?? null,
    status: ((row.status as VideoProjectStatus) ?? "writing") as VideoProjectStatus,
    error: (row.error as string | null) ?? null,
    scripts: (row.scripts as VideoScript[] | null) ?? null,
    chosen_script: (row.chosen_script as VideoScript | null) ?? null,
    progress: (row.progress as ScriptProgress | null) ?? null,
    plan: (row.plan as GenerationPlan | null) ?? null,
    clips: (row.clips as ClipState[] | null) ?? null,
    lease_until: (row.lease_until as string | null) ?? null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export async function createProject(input: { clientId: string; serviceId?: string | null; createdBy?: string | null; inputs: VideoInputs }): Promise<VideoProject> {
  const now = new Date().toISOString();
  const project: VideoProject = {
    id: `vid_${nanoid(12)}`,
    client_id: input.clientId,
    service_id: input.serviceId ?? null,
    created_by: input.createdBy ?? null,
    inputs: input.inputs,
    assets: [],
    brand: null,
    status: "writing",
    error: null,
    scripts: null,
    chosen_script: null,
    created_at: now,
    updated_at: now,
  };
  if (useMemory()) {
    memory().push(project);
    return project;
  }
  const { error } = await (await admin()).from("video_projects").insert(project);
  if (error) fail(error);
  return project;
}

export async function getProject(id: string): Promise<VideoProject | null> {
  if (useMemory()) return memory().find((p) => p.id === id) ?? null;
  const { data, error } = await (await admin()).from("video_projects").select("*").eq("id", id).maybeSingle();
  if (error) fail(error);
  return data ? mapRow(data as Record<string, unknown>) : null;
}

export async function listProjects(clientId: string, limit = 40): Promise<VideoProject[]> {
  if (useMemory()) {
    return memory().filter((p) => p.client_id === clientId).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit);
  }
  const { data, error } = await (await admin()).from("video_projects").select("*").eq("client_id", clientId).order("created_at", { ascending: false }).limit(limit);
  if (error) fail(error);
  return (data ?? []).map((r) => mapRow(r as Record<string, unknown>));
}

export async function updateProject(id: string, patch: Partial<Omit<VideoProject, "id" | "client_id" | "created_at">>): Promise<VideoProject> {
  const now = new Date().toISOString();
  if (useMemory()) {
    const p = memory().find((x) => x.id === id);
    if (!p) throw new Error("Video project not found");
    Object.assign(p, patch, { updated_at: now });
    return p;
  }
  const { data, error } = await (await admin()).from("video_projects").update({ ...patch, updated_at: now }).eq("id", id).select("*").single();
  if (error) fail(error);
  return mapRow(data as Record<string, unknown>);
}

/** Delete a project row. Its uploaded images are removed by the caller. */
export async function deleteProject(id: string): Promise<void> {
  if (useMemory()) {
    const list = memory();
    const i = list.findIndex((p) => p.id === id);
    if (i >= 0) list.splice(i, 1);
    return;
  }
  const { error } = await (await admin()).from("video_projects").delete().eq("id", id);
  if (error) fail(error);
}

/** Record progress. Best effort: a missing column or a slow write must never stop the scripts being written. */
export async function setProgress(id: string, progress: ScriptProgress): Promise<void> {
  try {
    await updateProject(id, { progress });
  } catch {
    // progress is a nicety
  }
}

/**
 * Take the project's working lease if nobody holds it, so two requests never advance the same video
 * at once. Returns false when someone else has it.
 */
export async function claimProjectLease(id: string, ms: number): Promise<boolean> {
  const now = new Date();
  const until = new Date(now.getTime() + ms).toISOString();
  if (useMemory()) {
    const p = memory().find((x) => x.id === id);
    if (!p) return false;
    if (p.lease_until && p.lease_until > now.toISOString()) return false;
    p.lease_until = until;
    return true;
  }
  const { data, error } = await (await admin())
    .from("video_projects")
    .update({ lease_until: until })
    .eq("id", id)
    .or(`lease_until.is.null,lease_until.lt.${now.toISOString()}`)
    .select("id");
  if (error) fail(error);
  return (data?.length ?? 0) > 0;
}

export async function releaseProjectLease(id: string): Promise<void> {
  await updateProject(id, { lease_until: null }).catch(() => undefined);
}
