import { z } from "zod";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated } from "@/lib/authz/assert";
import { parseBody } from "@/lib/api/response";
import {
  buildReportFilename,
  exportMarkdown,
  exportSimplePdf,
  exportWordHtml,
} from "@/lib/reports/export";

const schema = z.object({
  title: z.string().min(1).max(200).optional().default("Adspirer report"),
  content: z.string().min(1).max(200_000),
  format: z.enum(["md", "docx", "pdf"]),
});

export async function POST(request: Request) {
  try {
    const user = await getCurrentUser();
    assertAuthenticated(user);

    const body = await parseBody(request, schema);
    const filename = buildReportFilename(body.title, body.format);

    if (body.format === "md") {
      const text = exportMarkdown(body.title, body.content);
      return new Response(text, {
        status: 200,
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
      });
    }

    if (body.format === "docx") {
      const html = exportWordHtml(body.title, body.content);
      return new Response(html, {
        status: 200,
        headers: {
          "Content-Type": "application/msword; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
      });
    }

    const pdf = exportSimplePdf(body.title, body.content);
    return new Response(Buffer.from(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
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
