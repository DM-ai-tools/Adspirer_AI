import { z } from "zod";
import { getCurrentUser } from "@/lib/security/auth";
import {
  assertAuthenticated,
  assertClientAccess,
} from "@/lib/authz/assert";
import { startCreativeGeneration } from "@/lib/creatives/service";
import { runAfterResponse } from "@/lib/api/background";
import { jsonOk, parseBody, withApiHandler } from "@/lib/api/response";

export const maxDuration = 300;

const bodySchema = z.object({
  clientId: z.string().min(1),
  serviceId: z.string().optional(),
  conversationId: z.string().optional(),
  taskId: z.string().optional(),
  count: z.number().int().min(1).max(5).optional(),
  landingPageUrl: z.string().url().optional(),
  brandUrl: z.string().url().optional(),
  headline: z.string().optional(),
  primaryText: z.string().optional(),
  referenceBrief: z.string().max(4000).optional(),
  analyzeBrand: z.boolean().optional().default(true),
});

export async function POST(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    const body = await parseBody(request, bodySchema);
    await assertClientAccess(user.id, body.clientId);

    const { result, runImages } = await startCreativeGeneration({
      clientId: body.clientId,
      serviceId: body.serviceId,
      conversationId: body.conversationId,
      taskId: body.taskId,
      count: body.count,
      landingPageUrl: body.landingPageUrl,
      brandUrl: body.brandUrl,
      headline: body.headline,
      primaryText: body.primaryText,
      referenceBrief: body.referenceBrief,
      analyzeBrand: body.analyzeBrand,
      generateImages: true,
    });

    if (runImages) {
      runAfterResponse("workflow-creative-images", runImages);
    }

    return jsonOk({
      concepts: result.concepts,
      brandAnalysis: result.brandAnalysis,
      openaiConfigured: result.openaiConfigured,
      imageModel: result.imageModel,
      generatingImages: Boolean(runImages),
    });
  });
}
