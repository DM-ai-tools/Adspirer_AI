import { nanoid } from "nanoid";
import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import type { VideoScript } from "@/lib/video/script";
import type { AssetAnalysis } from "@/lib/video/assets";
import type { ScriptProgress } from "@/lib/video/progress";
import type { ClipState, FinalVideo, GenerationPlan } from "@/lib/video/generation-types";
import type { AssetPurpose, BrandManifest } from "@/lib/video/pipeline-types";
import type { AnglePlan, CreativeBrief } from "@/lib/video/script-types";

export type VideoAsset = {
  id: string;
  name: string;
  caption: string;
  role: "show" | "highlight";
  key: string;
  mime: string;
  /** What the image is and which stats it carries, read automatically. */
  analysis?: AssetAnalysis | null;
  /** What the file is for. A file that carries figures is the operator's approved proof. */
  purpose?: AssetPurpose;
  /** SHA-256 of the original bytes, taken when it was uploaded. The file is the same file only while this matches. */
  sha256?: string;
  bytes?: number;
  /** Goes up when a file is replaced; an id plus a version names exactly one set of bytes. */
  version?: number;
  uploadedAt?: string;
};

export type VideoInputs = {
  landingPageUrl?: string | null;
  instructions?: string | null;
  offerDetails?: string | null;
  stats: string[];
  targetSeconds: number;
  style: string;
  /** The kind of video the operator asked for before the script was read or written (see video-types.ts). */
  videoType?: string | null;
  /** The operator's own idea for the video, in their words. */
  videoIdea?: string | null;
  locale: string;
  format: "9:16" | "1:1" | "4:5";
  priority: "quality" | "balanced" | "cost";
  /** "upload": the operator brought their own script. */
  mode?: "write" | "upload";
  scriptText?: string | null;
  scriptFileName?: string | null;
  adCopyText?: string | null;
  /** Changes the operator wants made to their uploaded script. Empty means none: it is kept word for word. */
  changeRequest?: string | null;
  /** Optional creative inputs. Landing page plus length is enough; anything left empty is a visible default the operator can edit. */
  audience?: string | null;
  tone?: string | null;
  goal?: string | null;
  platform?: string | null;
  /** Words per second the narrator is assumed to speak at (the estimate is replaced by the measured length once audio exists). */
  speechRate?: number | null;
  /** How the operator wants a term said, e.g. { "ROAS": "roh-ass" }. These always win over every other pronunciation choice. */
  pronunciations?: Record<string, string>;
  /** Decisions the operator made about the brand: they are applied every time the brand is checked again. */
  brandChoice?: {
    /** The public company name, typed by the operator. */
    name?: string | null;
    /** A logo URL the operator picked from what the page offered. */
    logoUrl?: string | null;
    /** Storage key of a logo file the operator uploaded for this video. */
    logoUploadKey?: string | null;
    logoUploadName?: string | null;
    /** Use the verified company name as text when no logo can be verified. */
    allowTextOnly?: boolean;
    /** The stored logo file the operator looked at and approved (its storage key). A different file is not approved. */
    logoApprovedKey?: string | null;
    cta?: string | null;
    offer?: string | null;
  };
};

export type VideoBrand = {
  /** The verified public company name (from the manifest). Empty until one is verified. Never an internal label. */
  name: string;
  colors: string[] | null;
  /** Kept for old projects only. New videos use the verified logo in the manifest and never this. */
  logoUrl: string | null;
  summary: string | null;
  /** The verified brand source of truth: name, logo, offer, CTA and approved claims, each with where it came from. */
  manifest?: BrandManifest | null;
  /** What the scripts were written from, kept so a scene can be rewritten later without reading the site again. */
  facts?: string;
  corpus?: string;
  /** What the page really says, with sources, and what is missing. The scripts are written from this. */
  brief?: CreativeBrief | null;
  /** The angles the three versions were built on, kept so one version can be changed without losing the others. */
  angles?: AnglePlan[];
  /** Why fewer than three angles were made, when the source could not support more. */
  angleLimitation?: string | null;
};

export type VideoProjectStatus = "writing" | "needs_context" | "scripts_ready" | "confirmed" | "generating" | "paused" | "stopped" | "clips_ready" | "assembling" | "done" | "failed";

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
  final?: FinalVideo | null;
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
    final: (row.final as FinalVideo | null) ?? null,
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
