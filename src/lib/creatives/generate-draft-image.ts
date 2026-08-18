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
): Promise<DraftImageResult> {
  const existing = await getCreativeDraftAsync(draftId);
  if (!existing) {
    throw new Error("Creative draft not found");
  }

  await upsertCreativeDraftAsync({
    ...existing,
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
    creativeDirection: existing.creative_direction,
    headline: existing.headline,
    primaryText: existing.primary_text,
    logoUrl: existing.logo_url,
    landingPageUrl: existing.landing_page_url ?? undefined,
    revisionNotes: revisionNotes ?? existing.revision_notes,
    variantLabel: existing.concept.split("—").pop()?.trim() ?? null,
  });

  let image: Awaited<ReturnType<typeof generateOpenAIImage>>;
  try {
    image = await generateOpenAIImage({
      prompt,
      size: "1024x1024",
      quality: "medium",
      logoUrl: existing.logo_url,
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

  const succeeded = image.status === "succeeded";
  const hostedUrl =
    image.imageUrl &&
    /^https?:\/\//i.test(image.imageUrl) &&
    !image.imageUrl.startsWith("data:")
      ? image.imageUrl
      : image.b64 || image.imageUrl?.startsWith("data:")
        ? publicCreativeAssetUrl(existing.id)
        : image.imageUrl;

  const draft = await upsertCreativeDraftAsync({
    ...existing,
    id: existing.id,
    image_url: hostedUrl,
    image_b64: image.b64,
    image_model: image.model,
    image_prompt: image.prompt,
    image_status: image.status,
    image_error: image.error ?? null,
    revision_notes: revisionNotes ?? existing.revision_notes,
    status: succeeded
      ? revisionNotes
        ? "revised"
        : existing.status === "selected"
          ? "selected"
          : "ready"
      : "failed",
  });

  const displayUrl =
    image.b64 || image.imageUrl?.startsWith("data:")
      ? publicCreativeAssetUrl(draft.id)
      : image.imageUrl;

  return {
    draft,
    displayUrl,
    imageStatus: image.status,
    imageError: image.error ?? null,
  };
}
