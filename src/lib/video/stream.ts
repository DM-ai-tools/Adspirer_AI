/** Serve a video file with byte-range support, so a player can seek, and an optional download name (none: shown in a player only, never offered as a download). */
export function streamVideo(request: Request, bytes: Buffer, downloadName: string | null): Response {
  const headers: Record<string, string> = { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600" };
  if (downloadName && new URL(request.url).searchParams.has("download")) headers["Content-Disposition"] = `attachment; filename="${downloadName}"`;

  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "");
  if (range) {
    const total = bytes.length;
    const start = range[1] ? Math.min(Number(range[1]), total - 1) : 0;
    const end = range[2] ? Math.min(Number(range[2]), total - 1) : total - 1;
    const slice = bytes.subarray(start, end + 1);
    return new Response(new Uint8Array(slice), { status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${total}`, "Content-Length": String(slice.length) } });
  }
  return new Response(new Uint8Array(bytes), { headers: { ...headers, "Content-Length": String(bytes.length) } });
}
