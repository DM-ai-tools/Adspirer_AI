import { arkCredentials, arkRequest, type SeedanceModelKey } from "@/lib/video/seedance";

/**
 * Reference images for the video, made by Seedream on the SAME account as the video model.
 *
 * Seedance refuses uploaded images that contain real faces. It does accept unedited Seedream face
 * images from the same account, so the presenter's reference comes from here (not from another
 * image model) and is passed on by its original address, never re-saved or re-encoded.
 */
export const SEEDREAM_MODEL = "dola-seedream-5-0-pro-260628";

export type ReferenceKind = "presenter" | "location";

export function referencePrompt(kind: ReferenceKind, description: string): string {
  const d = description.replace(/\s+/g, " ").trim();
  if (kind === "presenter") {
    return `Photorealistic portrait photograph of ${d}. Shoulders-up, facing the camera with a relaxed, natural expression, soft even daylight, a plain softly blurred background, natural skin texture and fine detail, sharp focus. Vertical composition. No text, no logos, no watermark.`;
  }
  return `Photorealistic photograph of an empty ${d}. No people. Natural believable lighting, real materials and depth, sharp focus. Vertical composition. No text, no logos, no watermark.`;
}

/**
 * Make one reference image. The address returned is the model's own original; hand it to the video
 * model as it is. (The response is read as { data: [{ url }] }; check this against a live call.)
 */
export async function createReferenceImage(model: SeedanceModelKey, kind: ReferenceKind, description: string): Promise<{ url: string }> {
  const { apiKey } = arkCredentials(model);
  const res = await arkRequest<{ data?: Array<{ url?: string }> }>(apiKey, "/images/generations", {
    method: "POST",
    body: JSON.stringify({ model: SEEDREAM_MODEL, prompt: referencePrompt(kind, description), size: "2K", output_format: "png", watermark: false }),
  });
  const url = res?.data?.[0]?.url;
  if (!url) throw new Error("The image model returned no image address.");
  return { url };
}
