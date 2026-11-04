import { describe, expect, it } from "vitest";
import { META_AUDIT_FRAMEWORK } from "@/lib/agent/meta-audit-framework";
import type { AuditAdSet } from "@/lib/audit/meta-audit-data";
import { renderCatalogEvidence, type CatalogEvidenceInput } from "@/lib/audit/render";
import type { CatalogFinding, LearningLink } from "@/lib/meta/catalog/findings";
import type { CatalogSnapshot } from "@/lib/meta/catalog/types";

const snapshot = (over: Partial<CatalogSnapshot> = {}): CatalogSnapshot => ({
  id: "cat1",
  name: "Main shop",
  vertical: "commerce",
  productCount: 1200,
  diagnostics: [],
  productSets: [{ id: "ps1", name: "Bestsellers", filter: null, productCount: 300, inStockCount: 120 }],
  feeds: [],
  events: [],
  pixelIds: [],
  outOfStockCount: null,
  warnings: [],
  fetchedAt: "2026-11-04T00:00:00.000Z",
  ...over,
});

const finding = (over: Partial<CatalogFinding> = {}): CatalogFinding => ({
  id: "feed_stale:f1",
  severity: "medium",
  title: 'Feed "Daily" has not updated in 72 hours',
  evidence: ["Last upload finished 72 hours ago (threshold 48 hours)"],
  productSetIds: [],
  adSetIds: [],
  howToFix: "Request a feed refresh.",
  fix: null,
  ...over,
});

const adSet = (over: Partial<AuditAdSet> = {}): AuditAdSet =>
  ({ id: "as1", name: "Catalogue - Broad", campaignId: "c1", status: "ACTIVE", learningStatus: "FAIL", productSetId: "ps1", ...over }) as AuditAdSet;

const ok = (findings: CatalogFinding[], learningLinks: LearningLink[] = []): CatalogEvidenceInput => ({
  catalogName: "Main shop",
  catalogId: "cat1",
  snapshot: snapshot(),
  findings,
  learningLinks,
});

describe("renderCatalogEvidence", () => {
  it("renders nothing when there are no catalogue reports", () => {
    expect(renderCatalogEvidence([], [])).toBe("");
  });

  it("heads the section as authoritative live Meta data and names the catalogue", () => {
    const text = renderCatalogEvidence([ok([])], []);
    expect(text).toContain("### Catalogue (Commerce Manager) — live Meta data, authoritative");
    expect(text).toContain("Main shop");
    expect(text).toContain("cat1");
  });

  it("renders each finding as a bullet with its severity and evidence numbers", () => {
    const text = renderCatalogEvidence(
      [
        ok([
          finding(),
          finding({
            id: "small_product_set:ps1",
            severity: "high",
            title: 'Product set "Bestsellers" has too few in-stock items',
            evidence: ["12 in stock out of 300 items (minimum 20)"],
            howToFix: "Widen the filter.",
          }),
        ]),
      ],
      [],
    );
    expect(text).toMatch(/- \*\*Medium\*\* — Feed "Daily" has not updated in 72 hours/);
    expect(text).toContain("Last upload finished 72 hours ago (threshold 48 hours)");
    expect(text).toMatch(/- \*\*High\*\* — Product set "Bestsellers" has too few in-stock items/);
    expect(text).toContain("12 in stock out of 300 items (minimum 20)");
    expect(text).toContain("Fix: Request a feed refresh.");
  });

  it("says so when no catalogue problem was found", () => {
    expect(renderCatalogEvidence([ok([])], [])).toMatch(/no catalogue problems found/i);
  });

  it("notes parts of the catalogue that failed to load", () => {
    const report: CatalogEvidenceInput = { ...(ok([]) as Extract<CatalogEvidenceInput, { snapshot: CatalogSnapshot }>), snapshot: snapshot({ warnings: ["diagnostics failed to load"] }) };
    expect(renderCatalogEvidence([report], [])).toContain("diagnostics failed to load");
  });

  it("renders a likely-contributor link with the ad set name and reasons", () => {
    const text = renderCatalogEvidence(
      [ok([], [{ adSetId: "as1", productSetId: "ps1", verdict: "likely_contributor", reasons: ["Its product set has only 12 in-stock items.", "Feed is stale."] }])],
      [adSet()],
    );
    expect(text).toContain(
      'Ad set Catalogue - Broad (learning limited) → product set "Bestsellers" (ps1): likely contributor because Its product set has only 12 in-stock items.; Feed is stale.',
    );
  });

  it("renders a healthy link as a pointer to look elsewhere", () => {
    const text = renderCatalogEvidence(
      [ok([], [{ adSetId: "as1", productSetId: "ps1", verdict: "healthy", reasons: ["No catalogue problem found."] }])],
      [adSet()],
    );
    expect(text).toContain("Catalogue - Broad (learning limited) → product set");
    expect(text).toContain("catalogue looks healthy; look elsewhere");
  });

  it("renders links only for ad sets in this audit's scope, falling back to the id for unknown names", () => {
    const links: LearningLink[] = [
      { adSetId: "as1", productSetId: "ps1", verdict: "healthy", reasons: [] },
      { adSetId: "outside", productSetId: "ps1", verdict: "likely_contributor", reasons: ["x"] },
    ];
    const text = renderCatalogEvidence([ok([], links)], [adSet()]);
    expect(text).toContain("Catalogue - Broad");
    expect(text).not.toContain("outside");
    expect(renderCatalogEvidence([ok([], links)], [])).not.toContain("learning limited");
  });

  it("renders the permission warning exactly", () => {
    const text = renderCatalogEvidence(
      [{ catalogId: "cat1", missing: "missing_permission", message: "Facebook is connected without catalogue access." }],
      [],
    );
    expect(text).toContain("### Catalogue (Commerce Manager)");
    expect(text).toContain("Catalogue not read: reconnect Facebook to grant catalogue access");
    expect(text).not.toContain("Facebook is connected without catalogue access.");
  });

  it("renders other unreadable catalogues with their message", () => {
    const text = renderCatalogEvidence([{ catalogId: "cat1", missing: "no_catalog", message: "boom" }], []);
    expect(text).toContain("Catalogue not read: boom");
  });

  it("keeps a readable catalogue when another one could not be read", () => {
    const text = renderCatalogEvidence(
      [ok([finding()]), { catalogId: "cat2", missing: "no_catalog", message: "gone" }],
      [],
    );
    expect(text).toContain("Main shop");
    expect(text).toContain("Catalogue not read: gone");
  });
});

describe("catalogue lens in the framework", () => {
  it("adds a catalogue lens and report heading that apply only with catalogue evidence", () => {
    expect(META_AUDIT_FRAMEWORK).toContain("Catalogue (Commerce Manager)");
    expect(META_AUDIT_FRAMEWORK).toMatch(/only when the evidence has a "Catalogue \(Commerce Manager\)" section/i);
  });

  it("says the catalogue is not the cause when the link is healthy", () => {
    expect(META_AUDIT_FRAMEWORK).toContain("catalogue is not the cause");
  });
});
