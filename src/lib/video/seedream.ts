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
  // Candid, camera-made images: a reference that looks generated makes every clip built on it look generated too.
  if (kind === "presenter") {
    return `Candid photograph of ${d}, taken on a full-frame camera with a 50mm lens at eye level. Shoulders-up, facing the camera with a relaxed, natural expression, soft window daylight from one side, a real lived-in background softly out of focus. Real skin with pores, fine lines and slight unevenness, natural hair with flyaways, everyday clothes with natural creases, true-to-life colour, fine grain. Not a 3D render, not an illustration, not a stock photo, not airbrushed or retouched, no plastic or waxy skin, no glossy HDR. Vertical composition. No text, no logos, no watermark.`;
  }
  return `Photograph of an empty ${d}, taken on a full-frame camera with a 35mm lens at eye level. No people. Light from a real source (a window, a lamp or the sun) falling off naturally, real materials showing ordinary wear, everyday objects and a little clutter, natural depth, true-to-life colour, fine grain. Not a 3D render, not an architectural visualisation, not a stock photo, no glossy HDR, no oversaturated colour. Vertical composition. No text, no logos, no watermark.`;
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
