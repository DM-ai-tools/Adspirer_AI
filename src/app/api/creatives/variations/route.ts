import { z } from "zod";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { getCreativeDraftAsync, toPublicDraft } from "@/lib/creatives/drafts";
import { createVariationsOfDraft } from "@/lib/creatives/variations";
import { generateImagesForDrafts } from "@/lib/creatives/service";
import { appendWorkflowMessage } from "@/lib/workflow/events";
import { runAfterResponse } from "@/lib/api/background";
import { jsonOk, parseBody, withApiHandler } from "@/lib/api/response";

export const maxDuration = 300;

const bodySchema = z.object({
  draftId: z.string().min(1),
  count: z.number().int().min(1).max(4).optional().default(3),
});

/** "More like this": close variations of one image the operator picked. */
export async function POST(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    const body = await parseBody(request, bodySchema);
    const existing = await getCreativeDraftAsync(body.draftId);
    if (!existing) throw new Error("Creative draft not found");
    await assertClientAccess(user.id, existing.client_id);

    const { source, drafts } = await createVariationsOfDraft({ draftId: body.draftId, count: body.count });
    const brandName = source.concept.split("—")[0]?.trim();

    runAfterResponse("creative-variations", async () => {
      await generateImagesForDrafts({
        draftIds: drafts.map((d) => d.id),
        brandName,
        conversationId: source.conversation_id ?? undefined,
        taskId: source.task_id ?? undefined,
      });
    });

    if (source.conversation_id) {
      await appendWorkflowMessage({
        conversationId: source.conversation_id,
        taskId: source.task_id ?? undefined,
        eventType: "creative_generating",
        content: `Making ${drafts.length} close variation${drafts.length === 1 ? "" : "s"} of **${source.headline}**: same idea and style, similar wording. They appear below as each finishes.`,
        metadata: {
          ui: { creativePicker: { drafts: drafts.map(toPublicDraft), status: "generating" } },
          draftIds: drafts.map((d) => d.id),
        },
      }).catch(() => undefined);
    }

    return jsonOk({ drafts: drafts.map(toPublicDraft) });
  });
}
