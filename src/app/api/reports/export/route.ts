import { z } from "zod";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated } from "@/lib/authz/assert";
import { parseBody } from "@/lib/api/response";
import { exportReportPayload } from "@/lib/reports/export";

const schema = z.object({
  title: z.string().min(1).max(200).optional().default("Spendsmith report"),
  content: z.string().min(1).max(200_000),
  format: z.enum(["md", "docx", "pdf", "xlsx"]),
  /** Structured AuditReport JSON — preferred over markdown conversion. */
  report: z.unknown().optional(),
});

export async function POST(request: Request) {
  try {
    const user = await getCurrentUser();
    assertAuthenticated(user);

    const body = await parseBody(request, schema);
    const exported = await exportReportPayload({
      format: body.format,
      title: body.title,
      content: body.content,
      report: body.report,
    });

    const payload =
      typeof exported.body === "string"
        ? exported.body
        : Buffer.from(exported.body);

    return new Response(payload, {
      status: 200,
      headers: {
        "Content-Type": exported.contentType,
        "Content-Disposition": `attachment; filename="${exported.filename}"`,
        "X-Report-Quality": exported.quality.ok ? "pass" : "warn",
        "X-Report-Quality-Score": String(exported.quality.score),
        "X-Report-Polish-Passes": String(exported.polishPasses),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Export failed";
    return Response.json(
      { ok: false, error: { code: "EXPORT_FAILED", message } },
      { status: 400 },
    );
  }
}
