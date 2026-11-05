import { z } from "zod";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { IMAGE_FORMATS } from "@/lib/creatives/formats";
import { listRuns } from "@/lib/creatives/bulk/runs";
import { listCreativeDraftsAsync, toPublicDraft } from "@/lib/creatives/drafts";
import { planAndRender, startBulkRun } from "@/lib/creatives/bulk/run";
import { MONTHLY_TARGET, monthlyCount } from "@/lib/creatives/bulk/view";
import { BULK_RUN_SIZE } from "@/lib/creatives/bulk/plan";
import { runAfterResponse } from "@/lib/api/background";
import { jsonOk, parseBody, withApiHandler } from "@/lib/api/response";

export const maxDuration = 300;

const startSchema = z.object({
  clientId: z.string().min(1),
  serviceId: z.string().optional(),
  landingPageUrl: z.string().url().optional(),
  notes: z.string().max(4000).optional(),
  pastedCopy: z.string().max(4000).optional(),
  format: z.enum(IMAGE_FORMATS).optional().default("4:5"),
});

/** A run that is still planning or rendering and was touched recently. */
const ACTIVE_WINDOW_MS = 20 * 60 * 1000;

export async function GET(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    const clientId = new URL(request.url).searchParams.get("clientId");
    if (!clientId) throw new Error("clientId required");
    await assertClientAccess(user.id, clientId);
    const runs = await listRuns(clientId);
    // One read of the client's drafts gives every run its progress and a few thumbnails.
    const drafts = new Map((await listCreativeDraftsAsync(clientId)).map((d) => [d.id, d]));
    return jsonOk({
      runs: runs.map((r) => {
        const own = r.items.map((i) => drafts.get(i.draft_id)).filter((d): d is NonNullable<typeof d> => Boolean(d));
        const ready = own.filter((d) => d.image_status === "succeeded" && d.status !== "rejected");
        return {
          id: r.id,
          status: r.status,
          created_at: r.created_at,
          landing_page_url: r.landing_page_url,
          image_format: r.image_format,
          count: r.items.length,
          ready: ready.length,
          failed: own.filter((d) => d.image_status === "failed").length,
          thumbs: ready.slice(0, 4).map((d) => ({ id: d.id, url: toPublicDraft(d).image_url ?? null })),
        };
      }),
      monthly: { count: await monthlyCount(clientId, runs), target: MONTHLY_TARGET },
      runSize: BULK_RUN_SIZE,
    });
  });
}

export async function POST(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    const body = await parseBody(request, startSchema);
    await assertClientAccess(user.id, body.clientId);

    const recent = (await listRuns(body.clientId, 5)).find(
      (r) => (r.status === "planning" || r.status === "rendering") && Date.now() - Date.parse(r.updated_at) < ACTIVE_WINDOW_MS,
    );
    if (recent) throw new Error("A bulk run for this client is still in progress. Wait for it to finish before starting another.");

    const run = await startBulkRun({
      clientId: body.clientId,
      serviceId: body.serviceId,
      createdBy: user.id,
      landingPageUrl: body.landingPageUrl,
      notes: body.notes,
      pastedCopy: body.pastedCopy,
      format: body.format,
    });
    runAfterResponse("bulk-creative-run", () => planAndRender(run.id));
    return jsonOk({ runId: run.id });
  });
}
