import { z } from "zod";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { getRun } from "@/lib/creatives/bulk/runs";
import { saveAdCopy } from "@/lib/creatives/bulk/copy/edit-copy";
import { toPublicDraft } from "@/lib/creatives/drafts";
import { jsonOk, parseBody, withApiHandler } from "@/lib/api/response";

type Ctx = { params: Promise<{ runId: string }> };

const bodySchema = z.object({
  draftId: z.string().min(1),
  headline: z.string().optional(),
  primary_text: z.string().optional(),
  description: z.string().nullable().optional(),
});

/** Save the operator's own edit of one ad's copy (headline, primary text, description). Only that ad changes. */
export async function POST(request: Request, ctx: Ctx) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    const { runId } = await ctx.params;
    const run = await getRun(runId);
    if (!run) throw new Error("Run not found");
    await assertClientAccess(user.id, run.client_id);
    const body = await parseBody(request, bodySchema);
    const saved = await saveAdCopy({ runId, ...body });
    return jsonOk({ ad: toPublicDraft(saved) });
  });
}
