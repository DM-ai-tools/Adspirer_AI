import type { WorkspaceDocument } from "@/types";
import { logger } from "@/lib/observability/logger";

/** Largest side of a logo kept inline on a draft: sharp enough for an overlay, small enough for a row. */
const LOGO_MAX_SIDE = 640;

const isImage = (d: WorkspaceDocument) => /^image\//i.test(d.mime_type ?? "") && Boolean(d.storage_key);

/**
 * The image file the operator uploaded as their logo: one named like a logo, else
 * the only image attached to this chat when they talk about "the logo". Pure, so
 * the choice is testable without storage.
 */
export function pickLogoDocument(
  docs: WorkspaceDocument[],
  conversationId?: string | null,
  request = "",
): WorkspaceDocument | null {
  const images = docs.filter(isImage);
  const named = images.filter((d) => /logo|brandmark|wordmark/i.test(d.filename));
  const attached = (list: WorkspaceDocument[]) => (conversationId ? list.filter((d) => d.conversation_id === conversationId) : []);
  if (named.length) return attached(named)[0] ?? named[0] ?? null;
  const here = attached(images);
  if (here.length === 1 && /\blogo\b/i.test(request)) return here[0]!;
  return null;
}

/** The uploaded logo as a PNG data URI the image step takes like any other logo, or null. */
export async function loadUploadedLogoDataUri(input: {
  clientId: string;
  conversationId?: string | null;
  request?: string;
}): Promise<string | null> {
  try {
    const { loadDocumentsForContext } = await import("@/lib/documents/service");
    const doc = pickLogoDocument(
      await loadDocumentsForContext({ clientId: input.clientId, conversationId: input.conversationId ?? null }),
      input.conversationId,
      input.request,
    );
    if (!doc?.storage_key) return null;
    const { getObjectStorage } = await import("@/lib/storage/r2");
    const bytes = await getObjectStorage().get(doc.storage_key);
    if (!bytes) return null;
    const sharp = (await import("sharp")).default;
    const png = await sharp(bytes, /svg/i.test(doc.mime_type) ? { density: 300 } : undefined)
      .resize({ width: LOGO_MAX_SIDE, height: LOGO_MAX_SIDE, fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
    return `data:image/png;base64,${png.toString("base64")}`;
  } catch (error) {
    logger.warn("Could not use the uploaded logo", { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}
