import { v2 as cloudinary } from "cloudinary";
import { getConfig } from "@/lib/config";
import {
  upsertCreativeDraftAsync,
  type CreativeDraft,
} from "@/lib/creatives/drafts";

function isPublicHttpsUrl(value: string | null): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return (
      host !== "localhost" &&
      host !== "127.0.0.1" &&
      host !== "::1" &&
      !host.endsWith(".local")
    );
  } catch {
    return false;
  }
}

function imageDataUri(draft: CreativeDraft): string | null {
  if (draft.image_url?.startsWith("data:")) return draft.image_url;
  if (!draft.image_b64) return null;
  return `data:${draft.image_mime || "image/png"};base64,${draft.image_b64}`;
}

/**
 * Ensure Meta receives an internet-accessible HTTPS image URL.
 *
 * Generated assets are initially served through the app for preview. A local
 * APP_URL makes those links unusable by Meta, so the selected asset is uploaded
 * server-side to Cloudinary and the durable secure_url replaces the preview URL.
 */
export async function ensurePublicCreativeUrl(
  draft: CreativeDraft,
): Promise<{ draft: CreativeDraft; imageUrl: string }> {
  if (isPublicHttpsUrl(draft.image_url)) {
    return { draft, imageUrl: draft.image_url };
  }

  const config = getConfig();
  if (
    !config.CLOUDINARY_CLOUD_NAME ||
    !config.CLOUDINARY_API_KEY ||
    !config.CLOUDINARY_API_SECRET
  ) {
    throw new Error(
      "Cloudinary is not configured. Add CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET to .env.local, then restart the dev server.",
    );
  }

  const source = imageDataUri(draft);
  if (!source) {
    throw new Error(
      "This creative has no image data available to upload to Cloudinary. Rework or regenerate it, then try again.",
    );
  }

  cloudinary.config({
    cloud_name: config.CLOUDINARY_CLOUD_NAME,
    api_key: config.CLOUDINARY_API_KEY,
    api_secret: config.CLOUDINARY_API_SECRET,
    secure: true,
  });

  const result = await cloudinary.uploader.upload(source, {
    resource_type: "image",
    folder: `adspirer/clients/${draft.client_id}`,
    public_id: draft.id,
    overwrite: true,
    unique_filename: false,
    invalidate: true,
    tags: ["adspirer", "meta-creative"],
    context: {
      client_id: draft.client_id,
      draft_id: draft.id,
      headline: draft.headline.slice(0, 255),
    },
  });

  if (!result.secure_url || !isPublicHttpsUrl(result.secure_url)) {
    throw new Error("Cloudinary upload did not return a public HTTPS URL.");
  }

  const persisted = await upsertCreativeDraftAsync({
    ...draft,
    id: draft.id,
    image_url: result.secure_url,
    // Cloudinary is now the durable source; avoid retaining a large duplicate.
    image_b64: null,
    image_mime: result.format ? `image/${result.format}` : draft.image_mime,
  });

  return { draft: persisted, imageUrl: result.secure_url };
}
