import { manifestSummary, type LogoState } from "@/lib/video/brand-resolve";
import type { VideoProject } from "@/lib/video/projects";

/**
 * What the brand check found, in a shape the screen can show: no storage keys, no internal addresses.
 * `state` is read from storage by the caller: a logo is shown as verified only while its file can
 * actually be read, so the screen never claims a logo whose preview cannot load.
 */
export function brandView(project: VideoProject, state?: LogoState) {
  const m = project.brand?.manifest ?? null;
  if (!m) return { checked: false as const };
  const summary = manifestSummary(m);
  const accessible = state ? state.accessible : Boolean(m.logo);
  const base = `/api/creatives/video/${project.id}/brand/logo`;
  const v = encodeURIComponent(m.logo?.storageKey.split("/").pop() ?? m.createdAt);
  return {
    checked: true as const,
    ready: summary.blocking.length === 0,
    /** Ready for a clean video, which shows no logo: only what is spoken has to be settled. */
    readyForClean: summary.blocking.every((i) => i.field === "logo"),
    name: m.name.value,
    nameSources: m.name.provenance.map((p) => p.detail),
    nameCandidates: m.nameCandidates.map((c) => ({ value: c.value, source: c.provenance.detail, rejectedReason: c.rejectedReason ?? null })),
    internalLabels: m.internalLabels.map((l) => l.value),
    conflicts: m.conflicts.map((c) => ({ field: c.field, chosen: c.chosen, reason: c.reason, values: c.values.map((v2) => ({ value: v2.value, source: v2.provenance.detail })) })),
    hasLogo: Boolean(m.logo) && accessible,
    /** The logo is on record but its file cannot be read from storage. */
    logoMissing: Boolean(m.logo) && !accessible,
    logoState: state ?? { nameVerified: Boolean(m.name.value), found: Boolean(m.logo), saved: Boolean(m.logo), accessible, approved: false },
    logo:
      m.logo && accessible
        ? { width: m.logo.verification.width, height: m.logo.verification.height, hasAlpha: m.logo.verification.hasAlpha, origin: m.logo.origin, source: m.logo.sourceUrl, url: `${base}?v=${v}`, downloadUrl: `${base}?download=1&v=${v}`, legibleOnLight: m.logo.verification.legibleOnLight }
        : null,
    logoCandidates: m.logoCandidates.slice(0, 12).map((c) => ({ url: c.url.startsWith("data:") ? null : c.url, role: c.role, score: c.score, rejectedReason: c.rejectedReason ?? null, source: c.provenance.detail })),
    allowTextOnly: m.allowTextOnlyBrand,
    colors: m.colors.value,
    offer: m.offer.value,
    cta: m.cta.value,
    claims: m.claims.map((c) => ({ id: c.id, text: c.text, source: c.provenance.detail })),
    issues: m.issues,
    checkedAt: m.createdAt,
  };
}
