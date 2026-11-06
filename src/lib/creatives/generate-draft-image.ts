import { generationSize, readAspectMarker, stripAspectMarker, withAspectMarker, withLogoMarker, type ImageFormat } from "@/lib/creatives/formats";
import {
  buildBrandImagePrompt,
  generateOpenAIImage,
} from "@/lib/creatives/openai-image";
import {
  getCreativeDraftAsync,
  publicCreativeAssetUrl,
  upsertCreativeDraftAsync,
  type CreativeDraft,
} from "@/lib/creatives/drafts";
import {
  isCloudinaryConfigured,
  uploadCreativeImage,
} from "@/lib/creatives/cloudinary";
import { logger } from "@/lib/observability/logger";

export type DraftImageResult = {
  draft: CreativeDraft;
  displayUrl: string | null;
  imageStatus: "succeeded" | "failed" | "skipped";
  imageError: string | null;
};

export async function generateImageForDraft(
  draftId: string,
  brandName?: string,
  revisionNotes?: string | null,
  requestedFormat?: ImageFormat,
): Promise<DraftImageResult> {
  const existing = await getCreativeDraftAsync(draftId);
  if (!existing) {
    throw new Error("Creative draft not found");
  }

  // A rework keeps the shape the draft was made in unless a new one is asked for.
  const format: ImageFormat = requestedFormat ?? readAspectMarker(existing.creative_direction) ?? "4:5";
  const direction = requestedFormat
    ? withAspectMarker(existing.creative_direction, requestedFormat)
    : existing.creative_direction;

  await upsertCreativeDraftAsync({
    ...existing,
    creative_direction: direction,
    id: existing.id,
    image_status: "generating",
    image_error: null,
    status: existing.status === "selected" ? existing.status : "generating",
  });

  const prompt = buildBrandImagePrompt({
    brandName:
      brandName ??
      existing.concept.split("—")[0]?.trim() ??
      existing.headline,
    serviceName: existing.description ?? existing.concept,
    colors: existing.brand_colors,
    creativeDirection: stripAspectMarker(existing.creative_direction),
    headline: existing.headline,
    primaryText: existing.primary_text,
    logoUrl: existing.logo_url,
    landingPageUrl: existing.landing_page_url ?? undefined,
    revisionNotes: revisionNotes ?? existing.revision_notes,
    variantLabel: existing.concept.split("—").pop()?.trim() ?? null,
    format,
  });

  let image: Awaited<ReturnType<typeof generateOpenAIImage>>;
  try {
    image = await generateOpenAIImage({
      prompt,
      size: generationSize(format),
      logoUrl: existing.logo_url,
      format,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failed = await upsertCreativeDraftAsync({
      ...existing,
      id: existing.id,
      image_status: "failed",
      image_error: message,
      status: "failed",
    });
    return {
      draft: failed,
      displayUrl: null,
      imageStatus: "failed",
      imageError: message,
    };
  }

  const stored = await storeDraftImage(existing, {
    b64: image.b64,
    imageUrl: image.imageUrl,
    mime: image.mime,
    model: image.model,
    prompt: image.prompt,
    status: image.status,
    error: image.error ?? null,
    revisionNotes: revisionNotes ?? null,
    direction: image.logoBox ? withLogoMarker(direction, image.logoBox) : direction,
  });
  return {
    draft: stored.draft,
    displayUrl: stored.displayUrl,
    imageStatus: image.status,
    imageError: image.error ?? null,
  };
}

/**
 * Save a finished still on its draft: hosted in Cloudinary when that is set up (a base64 PNG is
 * 2-4 MB and was the fastest way to exhaust the database quota), else kept inline. Used by a fresh
 * render, a rework and an edit, so a still is always stored the same way.
 */
export async function storeDraftImage(
  existing: CreativeDraft,
  image: {
    b64: string | null;
    imageUrl: string | null;
    mime: string;
    model: string | null;
    prompt: string | null;
    status: "succeeded" | "failed" | "skipped";
    error: string | null;
    revisionNotes: string | null;
    direction: string | null;
  },
): Promise<{ draft: CreativeDraft; displayUrl: string | null }> {
  const succeeded = image.status === "succeeded";
  const inlineSource = image.b64
    ? `data:${image.mime || "image/png"};base64,${image.b64}`
    : image.imageUrl?.startsWith("data:")
      ? image.imageUrl
      : null;

  // Store generated stills in Cloudinary, not Postgres: a base64 PNG is
  // 2–4 MB per draft and was the fastest way to exhaust the database quota.
  let cloudUrl: string | null = null;
  let cloudMime: string | null = null;
  if (succeeded && inlineSource && isCloudinaryConfigured()) {
    try {
      const uploaded = await uploadCreativeImage({
        draftId: existing.id,
        clientId: existing.client_id,
        headline: existing.headline,
        source: inlineSource,
      });
      cloudUrl = uploaded.url;
      cloudMime = uploaded.mime;
    } catch (error) {
      // Keep the still inline so the operator still gets it; select retries.
      logger.warn("creative.cloudinary_upload_failed", {
        draftId: existing.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const hostedUrl =
    cloudUrl ??
    (image.imageUrl &&
    /^https?:\/\//i.test(image.imageUrl) &&
    !image.imageUrl.startsWith("data:")
      ? image.imageUrl
      : inlineSource
        ? publicCreativeAssetUrl(existing.id)
        : image.imageUrl);

  const draft = await upsertCreativeDraftAsync({
    ...existing,
    id: existing.id,
    creative_direction: image.direction ?? existing.creative_direction,
    image_url: hostedUrl,
    image_b64: cloudUrl ? null : image.b64,
    ...(cloudMime ? { image_mime: cloudMime } : {}),
    image_model: image.model,
    image_prompt: image.prompt,
    image_status: image.status,
    image_error: image.error ?? null,
    revision_notes: image.revisionNotes ?? existing.revision_notes,
    status: succeeded
      ? image.revisionNotes
        ? "revised"
        : existing.status === "selected"
          ? "selected"
          : "ready"
      : "failed",
  });

  const displayUrl =
    cloudUrl ??
    (inlineSource ? publicCreativeAssetUrl(draft.id) : image.imageUrl);
  return { draft, displayUrl };
}
