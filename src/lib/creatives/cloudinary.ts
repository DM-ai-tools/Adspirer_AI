import { v2 as cloudinary } from "cloudinary";
import { getConfig } from "@/lib/config";
import {
  getCreativeDraftAsync,
  upsertCreativeDraftAsync,
  type CreativeDraft,
} from "@/lib/creatives/drafts";

function isPublicHttpsUrl(value: string | null | undefined): value is string {
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

export function isCloudinaryConfigured(): boolean {
  const config = getConfig();
  return Boolean(
    config.CLOUDINARY_CLOUD_NAME &&
      config.CLOUDINARY_API_KEY &&
      config.CLOUDINARY_API_SECRET,
  );
}

/**
 * Upload a creative still and return its public HTTPS URL. The public_id is
 * the draft id, so reworks overwrite the same asset (the returned URL carries
 * a new version segment, which busts browser caches).
 */
export async function uploadCreativeImage(input: {
  draftId: string;
  clientId: string;
  headline: string;
  /** data: URI or a fetchable URL. */
  source: string;
}): Promise<{ url: string; mime: string | null }> {
  const config = getConfig();
  if (!isCloudinaryConfigured()) {
    throw new Error(
      "Cloudinary is not configured. Add CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET to .env.local, then restart the dev server.",
    );
  }

  cloudinary.config({
    cloud_name: config.CLOUDINARY_CLOUD_NAME,
    api_key: config.CLOUDINARY_API_KEY,
    api_secret: config.CLOUDINARY_API_SECRET,
    secure: true,
  });

  const result = await cloudinary.uploader.upload(input.source, {
    resource_type: "image",
    folder: `spendsmith/clients/${input.clientId}`,
    public_id: input.draftId,
    overwrite: true,
    unique_filename: false,
    invalidate: true,
    tags: ["spendsmith", "meta-creative"],
    context: {
      client_id: input.clientId,
      draft_id: input.draftId,
      headline: input.headline.slice(0, 255),
    },
  });

  if (!result.secure_url || !isPublicHttpsUrl(result.secure_url)) {
    throw new Error("Cloudinary upload did not return a public HTTPS URL.");
  }
  return {
    url: result.secure_url,
    mime: result.format ? `image/${result.format}` : null,
  };
}

/**
 * Ensure Meta receives an internet-accessible HTTPS image URL.
 *
 * New stills are uploaded when they are generated; this covers older drafts
 * whose bytes still live inline, and local APP_URL previews Meta can't fetch.
 */
export async function ensurePublicCreativeUrl(
  draft: CreativeDraft,
): Promise<{ draft: CreativeDraft; imageUrl: string }> {
  if (isPublicHttpsUrl(draft.image_url)) {
    return { draft, imageUrl: draft.image_url };
  }

  // Normal reads skip the inline bytes — load them only for this upload.
  const full =
    draft.image_b64 === undefined
      ? ((await getCreativeDraftAsync(draft.id, { withImageData: true })) ?? draft)
      : draft;
  const source = imageDataUri(full);
  if (!source) {
    throw new Error(
      "This creative has no image data available to upload to Cloudinary. Rework or regenerate it, then try again.",
    );
  }

  const uploaded = await uploadCreativeImage({
    draftId: full.id,
    clientId: full.client_id,
    headline: full.headline,
    source,
  });

  const persisted = await upsertCreativeDraftAsync({
    ...full,
    id: full.id,
    image_url: uploaded.url,
    // Cloudinary is now the durable source; drop the multi-MB copy in Postgres.
    image_b64: null,
    image_mime: uploaded.mime ?? full.image_mime,
  });

  return { draft: persisted, imageUrl: uploaded.url };
}
