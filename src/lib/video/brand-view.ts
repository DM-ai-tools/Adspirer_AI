import { manifestSummary } from "@/lib/video/brand-resolve";
import type { VideoProject } from "@/lib/video/projects";

/** What the brand check found, in a shape the screen can show: no storage keys, no internal addresses. */
export function brandView(project: VideoProject) {
  const m = project.brand?.manifest ?? null;
  if (!m) return { checked: false as const };
  const summary = manifestSummary(m);
  return {
    checked: true as const,
    ready: summary.blocking.length === 0,
    name: m.name.value,
    nameSources: m.name.provenance.map((p) => p.detail),
    nameCandidates: m.nameCandidates.map((c) => ({ value: c.value, source: c.provenance.detail, rejectedReason: c.rejectedReason ?? null })),
    internalLabels: m.internalLabels.map((l) => l.value),
    conflicts: m.conflicts.map((c) => ({ field: c.field, chosen: c.chosen, reason: c.reason, values: c.values.map((v) => ({ value: v.value, source: v.provenance.detail })) })),
    hasLogo: Boolean(m.logo),
    logo: m.logo ? { width: m.logo.verification.width, height: m.logo.verification.height, hasAlpha: m.logo.verification.hasAlpha, origin: m.logo.origin, source: m.logo.sourceUrl, url: `/api/creatives/video/${project.id}/brand/logo?v=${encodeURIComponent(m.createdAt)}` } : null,
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

