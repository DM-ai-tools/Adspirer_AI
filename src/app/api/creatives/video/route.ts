import { nanoid } from "nanoid";
import { z } from "zod";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { getObjectStorage } from "@/lib/storage/r2";
import { createProject, listProjects, updateProject, type VideoAsset } from "@/lib/video/projects";
import { writeProjectScripts } from "@/lib/video/brief";
import { projectName } from "@/lib/video/naming";
import { DEFAULT_SECONDS, MAX_SECONDS } from "@/lib/video/script";
import { runAfterResponse } from "@/lib/api/background";
import { jsonOk, withApiHandler } from "@/lib/api/response";

export const maxDuration = 300;

const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 8_000_000;
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

const payloadSchema = z.object({
  clientId: z.string().min(1),
  serviceId: z.string().optional(),
  landingPageUrl: z.string().url().optional(),
  instructions: z.string().max(4000).optional(),
  offerDetails: z.string().max(4000).optional(),
  stats: z.array(z.string().max(200)).max(12).default([]),
  targetSeconds: z.number().int().min(15).max(MAX_SECONDS).default(DEFAULT_SECONDS),
  style: z.string().max(60).default("auto"),
  locale: z.string().max(20).default("en-AU"),
  format: z.enum(["9:16", "1:1", "4:5"]).default("9:16"),
  priority: z.enum(["quality", "balanced", "cost"]).default("balanced"),
  /** Caption and role for each uploaded image, in upload order. */
  images: z.array(z.object({ caption: z.string().max(200).default(""), role: z.enum(["show", "highlight"]).default("show") })).default([]),
});

export async function GET(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    const clientId = new URL(request.url).searchParams.get("clientId");
    if (!clientId) throw new Error("clientId required");
    await assertClientAccess(user.id, clientId);
    const projects = await listProjects(clientId);
    return jsonOk({
      projects: projects.map((p) => ({
        id: p.id,
        status: p.status,
        created_at: p.created_at,
        landing_page_url: p.inputs.landingPageUrl ?? null,
        target_seconds: p.inputs.targetSeconds,
        name: projectName(p),
        title: p.chosen_script?.title ?? null,
      })),
    });
  });
}

/** multipart: `payload` (JSON) and optional `images` files. Starts writing the three scripts in the background. */
export async function POST(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    const form = await request.formData();
    const body = payloadSchema.parse(JSON.parse(String(form.get("payload") ?? "{}")));
    await assertClientAccess(user.id, body.clientId);
    if (!body.landingPageUrl && !body.instructions && !body.offerDetails && !body.serviceId) {
      throw new Error("Give a landing page, instructions or offer details so there is something to write from.");
    }

    const files = form.getAll("images").filter((f): f is File => f instanceof File);
    if (files.length > MAX_IMAGES) throw new Error(`Upload at most ${MAX_IMAGES} images.`);

    const project = await createProject({
      clientId: body.clientId,
      serviceId: body.serviceId,
      createdBy: user.id,
      inputs: {
        landingPageUrl: body.landingPageUrl ?? null,
        instructions: body.instructions ?? null,
        offerDetails: body.offerDetails ?? null,
        stats: body.stats.map((s) => s.trim()).filter(Boolean),
        targetSeconds: body.targetSeconds,
        style: body.style,
        locale: body.locale,
        format: body.format,
        priority: body.priority,
      },
    });

    const assets: VideoAsset[] = [];
    for (const [i, file] of files.entries()) {
      const mime = file.type || "";
      if (!EXT[mime]) throw new Error(`${file.name}: use a PNG, JPG or WebP image.`);
      if (file.size > MAX_IMAGE_BYTES) throw new Error(`${file.name} is over ${MAX_IMAGE_BYTES / 1_000_000} MB.`);
      const id = `img_${nanoid(8)}`;
      const key = `video/${project.id}/${id}.${EXT[mime]}`;
      await getObjectStorage().put(key, Buffer.from(await file.arrayBuffer()), mime);
      assets.push({ id, name: file.name, caption: body.images[i]?.caption ?? "", role: body.images[i]?.role ?? "show", key, mime });
    }
    if (assets.length) await updateProject(project.id, { assets });

    runAfterResponse("video-scripts", () => writeProjectScripts(project.id));
    return jsonOk({ projectId: project.id });
  });
}
