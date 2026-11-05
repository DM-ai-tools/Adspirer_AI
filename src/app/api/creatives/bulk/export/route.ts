import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { listCreativeDraftsAsync } from "@/lib/creatives/drafts";
import { getRun, listRuns, type CreativeRun } from "@/lib/creatives/bulk/runs";
import { buildRunsWorkbook, formatStamp } from "@/lib/creatives/bulk/export";
import { TABULAR_CONTENT_TYPES } from "@/lib/reports/tabular";
import { withApiHandler } from "@/lib/api/response";

/**
 * Excel export of bulk runs: `?runId=` for one run, or `?clientId=` for every run of a client
 * (the History tab). `tz` sets the time zone of the dates.
 */
export async function GET(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    const url = new URL(request.url);
    const timeZone = url.searchParams.get("tz") || "UTC";
    const runId = url.searchParams.get("runId");
    const clientId = url.searchParams.get("clientId");

    let runs: CreativeRun[];
    let owner: string;
    if (runId) {
      const run = await getRun(runId);
      if (!run) throw new Error("Run not found");
      await assertClientAccess(user.id, run.client_id);
      runs = [run];
      owner = run.client_id;
    } else if (clientId) {
      await assertClientAccess(user.id, clientId);
      runs = (await listRuns(clientId, 200)).reverse();
      owner = clientId;
    } else {
      throw new Error("runId or clientId required");
    }
    if (!runs.length) throw new Error("No bulk runs to export yet");

    const drafts = new Map((await listCreativeDraftsAsync(owner)).map((d) => [d.id, d]));
    const body = buildRunsWorkbook(runs.map((run) => ({ run, drafts })), timeZone);
    const stamp = formatStamp(runs[runs.length - 1]!.created_at, timeZone).slice(0, 10);
    const filename = runId ? `bulk-run-${stamp}-${runId.slice(4, 10)}.xlsx` : `bulk-runs-history-${formatStamp(new Date().toISOString(), timeZone).slice(0, 10)}.xlsx`;

    return new Response(Buffer.from(body), {
      status: 200,
      headers: {
        "Content-Type": TABULAR_CONTENT_TYPES.xlsx,
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  });
}
