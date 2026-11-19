import { generationSize, readAspectMarker, stripAspectMarker, withAspectMarker, withLogoMarker, type ImageFormat } from "@/lib/creatives/formats";
import { generateOpenAIImage } from "@/lib/creatives/openai-image";
import { getCreativeDraftAsync, upsertCreativeDraftAsync } from "@/lib/creatives/drafts";
import { storeDraftImage, type DraftImageResult } from "@/lib/creatives/generate-draft-image";
import { readDirectedMarker } from "@/lib/creatives/directed/markers";
import { buildDirectedImagePrompt } from "@/lib/creatives/directed/prompt";

/**
 * Render the image for a directed draft: the operator's picture instruction and printed words are the
 * whole brief. Called by `generateImageForDraft` for any draft that carries the directed marker, so a
 * rework, a bulk render and a variation all come through here.
 */
export async function renderDirectedDraft(draftId: string, options: { revisionNotes?: string | null; format?: ImageFormat } = {}): Promise<DraftImageResult> {
  const existing = await getCreativeDraftAsync(draftId);
  if (!existing) throw new Error("Creative draft not found");
  const meta = readDirectedMarker(existing.creative_direction);
  if (!meta) throw new Error("This draft was not made from a direction.");

  const format: ImageFormat = options.format ?? readAspectMarker(existing.creative_direction) ?? "4:5";
  const direction = options.format ? withAspectMarker(existing.creative_direction, options.format) : existing.creative_direction;
  await upsertCreativeDraftAsync({
    ...existing,
    id: existing.id,
    creative_direction: direction,
    image_status: "generating",
    image_error: null,
    status: existing.status === "selected" ? existing.status : "generating",
  });

  const logoUrl = meta.noLogo ? null : existing.logo_url;
  const prompt = buildDirectedImagePrompt({
    picture: meta.picture,
    print: meta.print,
    format,
    colors: existing.brand_colors,
    hasLogo: Boolean(logoUrl),
    tweak: meta.tweak,
    edits: meta.edits,
    revisionNotes: options.revisionNotes ?? existing.revision_notes,
  });

  let image: Awaited<ReturnType<typeof generateOpenAIImage>>;
  try {
    image = await generateOpenAIImage({ prompt, size: generationSize(format), logoUrl, format });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failed = await upsertCreativeDraftAsync({ ...existing, id: existing.id, creative_direction: direction, image_status: "failed", image_error: message, status: "failed" });
    return { draft: failed, displayUrl: null, imageStatus: "failed", imageError: message };
  }

  const stored = await storeDraftImage(existing, {
    b64: image.b64,
    imageUrl: image.imageUrl,
    mime: image.mime,
    model: image.model,
    prompt: image.prompt,
    status: image.status,
    error: image.error ?? null,
    revisionNotes: options.revisionNotes ?? null,
    direction: image.logoBox ? withLogoMarker(direction, image.logoBox) : direction,
  });
  return { draft: stored.draft, displayUrl: stored.displayUrl, imageStatus: image.status, imageError: image.error ?? null };
}

/** The picture instruction as a plain string, for places that only show a short description. */
export function describeDirected(creativeDirection: string | null | undefined): string | null {
  return readDirectedMarker(creativeDirection)?.picture ?? (stripAspectMarker(creativeDirection) || null);
}
