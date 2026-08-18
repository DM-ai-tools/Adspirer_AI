import { z } from "zod";
import { getCurrentUser } from "@/lib/security/auth";
import {
  assertAuthenticated,
  assertClientAccess,
} from "@/lib/authz/assert";
import { generateImageForDraft } from "@/lib/creatives/generate-draft-image";
import { getCreativeDraftAsync } from "@/lib/creatives/drafts";
import { jsonOk, parseBody, withApiHandler } from "@/lib/api/response";

export const maxDuration = 180;

const bodySchema = z.object({
  draftId: z.string().min(1),
  brandName: z.string().optional(),
});

export async function POST(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    const body = await parseBody(request, bodySchema);

    const existing = await getCreativeDraftAsync(body.draftId);
    if (!existing) throw new Error("Creative draft not found");
    await assertClientAccess(user.id, existing.client_id);

    const result = await generateImageForDraft(body.draftId, body.brandName);

    return jsonOk({
      draft: {
        ...result.draft,
        image_url: result.displayUrl ?? result.draft.image_url,
      },
      imageStatus: result.imageStatus,
      imageError: result.imageError,
    });
  });
}
