import { beforeEach, describe, expect, it, vi } from "vitest";

const service = vi.hoisted(() => ({ commerce: vi.fn(), report: vi.fn() }));
vi.mock("@/lib/meta/catalog/service", () => ({
  getClientCommerce: (...a: unknown[]) => service.commerce(...a),
  getCatalogReport: (...a: unknown[]) => service.report(...a),
}));

import { META_AUDIT_FRAMEWORK } from "@/lib/agent/meta-audit-framework";
import { CATALOG_EVIDENCE_TIMEOUT_MS, loadCatalogEvidence } from "@/lib/meta/catalog/audit-evidence";
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
    // One catalogue was read, so the section stays authoritative.
    expect(text).toContain("— live Meta data, authoritative");
  });

  it("heads the section as not read when no catalogue was read", () => {
    const text = renderCatalogEvidence([{ catalogId: "", missing: "no_catalog", message: "Meta was slow to respond" }], []);
    expect(text.split("\n")[0]).toBe("### Catalogue (Commerce Manager) — not read");
    expect(text).not.toContain("authoritative");
    expect(text).toContain("Catalogue not read: Meta was slow to respond");
  });

  it("renders catalogs_unreadable with its message", () => {
    const text = renderCatalogEvidence(
      [{ catalogId: "", missing: "catalogs_unreadable", message: "2 catalogue ad sets found, but your Facebook login can't read their product sets" }],
      [],
    );
    expect(text).toContain("Catalogue not read: 2 catalogue ad sets found");
  });

  it("counts catalogues past the cap that were not checked", () => {
    expect(renderCatalogEvidence([ok([])], [], { notChecked: 2 })).toContain("2 more catalogues not checked");
    expect(renderCatalogEvidence([ok([])], [], { notChecked: 1 })).toContain("1 more catalogue not checked");
    expect(renderCatalogEvidence([ok([])], [])).not.toContain("not checked");
  });
});

describe("loadCatalogEvidence", () => {
  const set = (catalogId: string, i: number) => ({
    adSetId: `as${i}`,
    adSetName: `A${i}`,
    campaignId: "c1",
    accountId: "act_1",
    productSetId: `ps${i}`,
    learningStatus: null,
    effectiveStatus: "ACTIVE",
    catalogId,
  });

  beforeEach(() => {
    service.commerce.mockReset();
    service.report.mockReset();
  });

  it("falls back to 'Meta was slow to respond' when the catalogue reads take too long", async () => {
    service.commerce.mockReturnValue(new Promise(() => {}));
    const started = Date.now();
    const text = await loadCatalogEvidence("c1", [adSet()], 20);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(text).toContain("### Catalogue (Commerce Manager) — not read");
    expect(text).toContain("Catalogue not read: Meta was slow to respond");
    expect(CATALOG_EVIDENCE_TIMEOUT_MS).toBe(20_000);
  });

  it("reads at most three catalogues and counts the rest", async () => {
    const uses = ["cA", "cB", "cC", "cD", "cE"].map((c, i) => set(c, i + 1));
    service.commerce.mockResolvedValue({ state: "ok", catalogs: [], uses });
    service.report.mockImplementation(async (_client: string, catalogId: string) => ({
      state: "ok",
      snapshot: snapshot({ id: catalogId, name: `Shop ${catalogId}` }),
      findings: [],
      learningLinks: [],
      uses: [],
    }));
    const scope = uses.map((u, i) => adSet({ id: u.adSetId, productSetId: `ps${i + 1}` }));
    const text = (await loadCatalogEvidence("c1", scope))!;
    expect(service.report).toHaveBeenCalledTimes(3);
    expect(text).toContain("2 more catalogues not checked");
  });

  it("passes catalogs_unreadable through as its own state", async () => {
    service.commerce.mockResolvedValue({ state: "catalogs_unreadable", message: "1 catalogue ad set found, but no access" });
    const text = await loadCatalogEvidence("c1", [adSet()]);
    expect(text).toContain("— not read");
    expect(text).toContain("Catalogue not read: 1 catalogue ad set found, but no access");
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
