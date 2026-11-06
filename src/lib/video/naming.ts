/** "https://www.example.com.au/audit/?x=1" becomes "example.com.au/audit". Falls back to the text as typed. */
export function nameFromUrl(url: string | null | undefined): string | null {
  const raw = (url ?? "").trim();
  if (!raw) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    const host = u.hostname.replace(/^www\./, "");
    const path = u.pathname.replace(/\/+$/, "");
    return `${host}${path}`.slice(0, 80);
  } catch {
    return raw.slice(0, 80);
  }
}

/** What a project is called in lists: its landing page, else the brand, else a plain default. */
export function projectName(project: { inputs: { landingPageUrl?: string | null }; brand?: { name?: string | null } | null }): string {
  return nameFromUrl(project.inputs.landingPageUrl) ?? project.brand?.name ?? "Untitled video";
}
