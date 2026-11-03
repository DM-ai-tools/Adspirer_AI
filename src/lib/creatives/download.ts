/** "Spring Sale — 20% off!" → "spring-sale-20-off", for a download's file name. */
export function downloadFileName(headline: string | null | undefined, mime: string, id: string): string {
  const slug = (headline ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const ext = /jpe?g/i.test(mime) ? "jpg" : /webp/i.test(mime) ? "webp" : "png";
  return `${slug || "creative"}-${id.slice(0, 6)}.${ext}`;
}

/** Same-origin URL that saves the still as a file (works for inline and hosted images). */
export function creativeDownloadUrl(draftId: string): string {
  return `/api/creatives/assets/${encodeURIComponent(draftId)}?download=1`;
}
