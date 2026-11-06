import { z } from "zod";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { getCreativeDraftAsync, upsertCreativeDraftAsync } from "@/lib/creatives/drafts";
import { getRun } from "@/lib/creatives/bulk/runs";
import { editImage, undoLastEdit } from "@/lib/creatives/edit-image";
import { runAfterResponse } from "@/lib/api/background";
import { jsonOk, parseBody, withApiHandler } from "@/lib/api/response";

export const maxDuration = 300;
type Ctx = { params: Promise<{ runId: string }> };

const bodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("edit"),
    draftId: z.string().min(1),
    instruction: z.string().min(3).max(1500),
    /** "edit": change only what is described. "full": regenerate the whole image with this feedback. */
    mode: z.enum(["edit", "full"]).default("edit"),
  }),
  z.object({ action: z.literal("undo"), draftId: z.string().min(1) }),
]);

/** Edit one image of a bulk run from the operator's feedback, or undo the last edit. */
export async function POST(request: Request, ctx: Ctx) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    const { runId } = await ctx.params;
    const run = await getRun(runId);
    if (!run) throw new Error("Run not found");
    await assertClientAccess(user.id, run.client_id);
    const body = await parseBody(request, bodySchema);
    if (!run.items.some((i) => i.draft_id === body.draftId)) throw new Error("That image is not part of this run.");
    const draft = await getCreativeDraftAsync(body.draftId);
    if (!draft) throw new Error("Creative draft not found");

    if (body.action === "undo") {
      await undoLastEdit(body.draftId);
      return jsonOk({ undone: true });
    }

    // Show the card as rendering at once; the edit itself runs after the response.
    await upsertCreativeDraftAsync({ ...draft, id: draft.id, image_status: "generating", image_error: null });
    runAfterResponse("bulk-image-edit", () => editImage({ draftId: body.draftId, instruction: body.instruction, mode: body.mode }));
    return jsonOk({ started: true });
  });
}
