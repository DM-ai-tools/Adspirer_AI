import { getCreativeDraftAsync } from "@/lib/creatives/drafts";
import { downloadFileName } from "@/lib/creatives/download";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const wantsDownload = new URL(_request.url).searchParams.has("download");
  const draft = await getCreativeDraftAsync(id, { withImageData: true });
  if (!draft) {
    return new Response("Not found", { status: 404 });
  }

  let b64 = draft.image_b64;
  if (!b64 && draft.image_url?.startsWith("data:")) {
    const match = draft.image_url.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      b64 = match[2]!;
    }
  }

  if (!b64) {
    if (draft.image_url && /^https?:\/\//i.test(draft.image_url)) {
      if (wantsDownload) {
        // A redirect would open the hosted file instead of saving it; fetch it so the
        // browser gets an attachment under a proper name.
        const hosted = await fetch(draft.image_url, { signal: AbortSignal.timeout(30_000) });
        if (hosted.ok) {
          const mime = hosted.headers.get("content-type") ?? draft.image_mime ?? "image/png";
          return new Response(await hosted.arrayBuffer(), {
            status: 200,
            headers: {
              "Content-Type": mime,
              "Content-Disposition": `attachment; filename="${downloadFileName(draft.headline, mime, draft.id)}"`,
              "Cache-Control": "private, no-store",
            },
          });
        }
      }
      return Response.redirect(draft.image_url, 302);
    }
    return new Response("No image", { status: 404 });
  }

  const bytes = Buffer.from(b64, "base64");
  const versioned = new URL(_request.url).searchParams.has("v");
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": draft.image_mime || "image/png",
      ...(wantsDownload
        ? { "Content-Disposition": `attachment; filename="${downloadFileName(draft.headline, draft.image_mime || "image/png", draft.id)}"` }
        : {}),
      // Versioned URLs (`?v=<updated_at>`) never change, so the browser can
      // keep the still instead of re-downloading multi-MB bytes on every poll.
      "Cache-Control": versioned
        ? "public, max-age=31536000, immutable"
        : "public, max-age=3600",
    },
  });
}
