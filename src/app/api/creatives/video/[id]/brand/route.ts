import { nanoid } from "nanoid";
import { z } from "zod";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { getObjectStorage } from "@/lib/storage/r2";
import { analyzeBrandFromUrl } from "@/lib/brand/analyze-url";
import { loadScope } from "@/lib/creatives/service";
import { getProject, updateProject, type VideoProject } from "@/lib/video/projects";
import { buildBrandForProject } from "@/lib/video/brief";
import { brandView } from "@/lib/video/brand-view";
import { logoState, restoreManifestLogo } from "@/lib/video/brand-resolve";
import { jsonOk, parseBody, withApiHandler } from "@/lib/api/response";

export const maxDuration = 120;
type Ctx = { params: Promise<{ id: string }> };

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/svg+xml": "svg" };
const MAX_LOGO_BYTES = 5_000_000;

async function load(ctx: Ctx) {
  const user = await getCurrentUser();
  assertAuthenticated(user);
  const { id } = await ctx.params;
  const project = await getProject(id);
  if (!project) throw new Error("Video project not found");
  await assertClientAccess(user.id, project.client_id);
  return project;
}

/**
 * The brand as the screen shows it, with the logo's state read from storage now: found, saved,
 * readable, approved. A logo whose file has gone is first put back from where it came from (the
 * operator's upload, or the page it was read from) when that yields the same file.
 */
async function view(project: VideoProject) {
  const manifest = project.brand?.manifest ?? null;
  const choice = project.inputs.brandChoice ?? {};
  if (manifest?.logo) await restoreManifestLogo(manifest, { uploadKey: choice.logoUploadKey }).catch(() => false);
  return brandView(project, await logoState(manifest, choice.logoApprovedKey));
}

export async function GET(_request: Request, ctx: Ctx) {
  return withApiHandler(async () => jsonOk(await view(await load(ctx))));
}

const bodySchema = z.discriminatedUnion("action", [
  /** Check the brand again (a project made before the brand check existed, or after the page changed). */
  z.object({ action: z.literal("refresh") }),
  /** The operator has looked at the saved logo and approves this exact file (or withdraws that). */
  z.object({ action: z.literal("approve_logo"), approved: z.boolean() }),
  /** The operator's decisions. They are kept and applied every time the brand is checked. */
  z.object({
    action: z.literal("choose"),
    name: z.string().max(120).nullable().optional(),
    /** The page to read the brand from, for a video that was started without one. */
    landingPageUrl: z.string().url().nullable().optional(),
    logoUrl: z.string().url().nullable().optional(),
    allowTextOnly: z.boolean().optional(),
    cta: z.string().max(60).nullable().optional(),
    offer: z.string().max(200).nullable().optional(),
  }),
]);

async function recheck(project: VideoProject): Promise<VideoProject> {
  const scope = await loadScope({ clientId: project.client_id, serviceId: project.service_id ?? undefined });
  const landing = project.inputs.landingPageUrl || scope.service?.landing_page_url || scope.client.website_url || undefined;
  let analysis: Awaited<ReturnType<typeof analyzeBrandFromUrl>> | null = null;
  if (landing) analysis = await analyzeBrandFromUrl(landing).catch(() => null);
  const typed = project.brand?.manifest?.claims.filter((c) => c.id.startsWith("claim_op_")) ?? [];
  const manifest = await buildBrandForProject(project, analysis, scope, typed);
  const brand = { ...(project.brand ?? { summary: null, colors: null, logoUrl: null, name: "" }), name: manifest.name.value ?? "", colors: manifest.colors.value.length ? manifest.colors.value : (project.brand?.colors ?? null), logoUrl: null, manifest };
  return updateProject(project.id, { brand });
}

/** Re-check the brand, or record what the operator decided (a name, a logo picked from the page, text-only) and check again. */
export async function POST(request: Request, ctx: Ctx) {
  return withApiHandler(async () => {
    let project = await load(ctx);
    const contentType = request.headers.get("content-type") ?? "";

    // A logo file uploaded by the operator: kept untouched, verified like any other candidate, and never replaced by anything else.
    if (contentType.startsWith("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("logo");
      if (!(file instanceof File) || file.size === 0) throw new Error("Choose a logo file to upload.");
      const mime = file.type || "";
      if (!EXT[mime]) throw new Error("Use a PNG, JPG, WebP or SVG logo.");
      if (file.size > MAX_LOGO_BYTES) throw new Error("The logo is over 5 MB.");
      const key = `video/${project.id}/brand-upload-${nanoid(8)}.${EXT[mime]}`;
      await getObjectStorage().put(key, Buffer.from(await file.arrayBuffer()), mime);
      const prior = project.inputs.brandChoice ?? {};
      // A newly uploaded logo is a different file: an approval given to the earlier one does not carry over.
      project = await updateProject(project.id, { inputs: { ...project.inputs, brandChoice: { ...prior, logoUploadKey: key, logoUploadName: file.name, logoUrl: null, logoApprovedKey: null } } });
      return jsonOk(await view(await recheck(project)));
    }

    const body = await parseBody(request, bodySchema);
    if (body.action === "approve_logo") {
      const logo = project.brand?.manifest?.logo;
      if (!logo) throw new Error("There is no saved logo to approve.");
      const state = await logoState(project.brand!.manifest, null);
      if (body.approved && !state.accessible) throw new Error("The logo file cannot be read from storage, so it cannot be approved. Check the brand again or upload the logo.");
      const prior = project.inputs.brandChoice ?? {};
      project = await updateProject(project.id, { inputs: { ...project.inputs, brandChoice: { ...prior, logoApprovedKey: body.approved ? logo.storageKey : null } } });
      return jsonOk(await view(project));
    }
    if (body.action === "choose") {
      const prior = project.inputs.brandChoice ?? {};
      const next = { ...prior };
      if (body.name !== undefined) next.name = body.name?.trim() || null;
      if (body.logoUrl !== undefined) {
        next.logoUrl = body.logoUrl;
        if (body.logoUrl) next.logoUploadKey = null;
      }
      if (body.allowTextOnly !== undefined) next.allowTextOnly = body.allowTextOnly;
      if (body.landingPageUrl !== undefined) project = await updateProject(project.id, { inputs: { ...project.inputs, landingPageUrl: body.landingPageUrl } });
      if (body.cta !== undefined) next.cta = body.cta?.trim() || null;
      if (body.offer !== undefined) next.offer = body.offer?.trim() || null;
      project = await updateProject(project.id, { inputs: { ...project.inputs, brandChoice: next } });
    }
    return jsonOk(await view(await recheck(project)));
  });
}
