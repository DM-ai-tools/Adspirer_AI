import { afterEach, describe, expect, it, vi } from "vitest";
import { gatherDiagnoseEvidence } from "@/lib/agent/adspirer-agent";
import { detectRequestIntent } from "@/lib/agent/task-plan";
import { getDemoStore, resetDemoStore } from "@/lib/demo/store";
import { scanSiteCandidates } from "@/lib/scraping/site-scan";
import type { CategoryCandidate } from "@/lib/scraping/site-map";
import { categoriesFromServices } from "@/lib/strategy/categories";
import {
  cachedSiteScan,
  pickCandidateForRequest,
  requestedCategoryPhrase,
  resetSiteScanCache,
  resolveRequestedCategory,
} from "@/lib/strategy/requested-category";

// The website scan is slow and external; every test here says what it returns.
vi.mock("@/lib/scraping/site-scan", () => ({ scanSiteCandidates: vi.fn() }));

const CT = "client_clicktrends";
const SITE = "https://clicktrends.example";
const STRATEGY_ASK = "How do we spend $4k and get $40k back on bar stools using Google Ads and Meta together?";
const SPEND_ASK = "How much has gone into bar stools, what did it return, and what was the best category in the last 30 days?";
const candidate = (name: string, slug: string): CategoryCandidate => ({
  name,
  landing_page_url: `${SITE}/collections/${slug}`,
  alreadyAdded: false,
});
const BAR_STOOLS = candidate("Bar Stools", "bar-stools");
const BLACK_BAR_STOOLS = candidate("Black Bar Stools", "black-bar-stools");
const ADJUSTABLE_BAR_STOOLS = candidate("Adjustable Bar Stools", "adjustable-bar-stools");
const SOFAS = candidate("Sofas", "sofas");
const ADDED_LINE =
  `Added **Bar Stools** (${SITE}/collections/bar-stools) as a category for ClickTrends. ` +
  `Set its margin on the Services tab, or tell me ("bar stools margin is 45%"), for sharper targets.`;

afterEach(() => {
  resetDemoStore();
  resetSiteScanCache();
  vi.mocked(scanSiteCandidates).mockReset();
  vi.restoreAllMocks();
});

/** ClickTrends with no categories set up, and a scan that returns `candidates`. */
function noCategories(candidates: CategoryCandidate[]) {
  const store = getDemoStore();
  store.clientServices = store.clientServices.filter((s) => s.client_id !== CT);
  vi.mocked(scanSiteCandidates).mockResolvedValue({ candidates, source: "firecrawl" });
}

const ctServices = () => getDemoStore().clientServices.filter((s) => s.client_id === CT);

describe("requestedCategoryPhrase", () => {
  it("reads the words after on/for/into up to using/with/at/over/in the/punctuation", () => {
    expect(requestedCategoryPhrase(STRATEGY_ASK, "strategy")).toBe("bar stools");
    expect(requestedCategoryPhrase("Build a plan for dining chairs with a $300/day budget", "strategy")).toBe("dining chairs");
    expect(requestedCategoryPhrase("Plan 8x ROAS on the outdoor sofas over Q4", "strategy")).toBe("outdoor sofas");
    expect(requestedCategoryPhrase("Scale spend on bar stools in the next month", "strategy")).toBe("bar stools");
    expect(requestedCategoryPhrase("how much has gone into bar stools", "spend")).toBe("bar stools");
    expect(requestedCategoryPhrase("What have we spent on bar stools?", "spend")).toBe("bar stools");
  });

  it("finds nothing when the words name money, a period or a channel", () => {
    expect(requestedCategoryPhrase("Plan to hit 10x ROAS on $500/day", "strategy")).toBeNull();
    expect(requestedCategoryPhrase("Build me a strategy", "strategy")).toBeNull();
    expect(requestedCategoryPhrase("Plan for the next 30 days", "strategy")).toBeNull();
    expect(requestedCategoryPhrase("Plan a strategy for Q4 on bar stools", "strategy")).toBe("bar stools");
    expect(requestedCategoryPhrase("How much have we spent on Meta this month?", "spend")).toBeNull();
    expect(requestedCategoryPhrase("How much have we spent on ads?", "spend")).toBeNull();
  });

  it("needs a spend word before on/into for a category-spend ask", () => {
    expect(requestedCategoryPhrase("Which ads are on bar stools?", "spend")).toBeNull();
    expect(requestedCategoryPhrase("What was the best category last month?", "spend")).toBeNull();
  });
});

describe("pickCandidateForRequest", () => {
  const all = [BLACK_BAR_STOOLS, ADJUSTABLE_BAR_STOOLS, candidate("Stools", "stools"), BAR_STOOLS, SOFAS];

  it("picks the longest name the request contains, never a longer one it doesn't", () => {
    expect(pickCandidateForRequest(STRATEGY_ASK, all)).toEqual(BAR_STOOLS);
    expect(pickCandidateForRequest("how much has gone into bar stools", all)).toEqual(BAR_STOOLS);
  });

  it("is whole-word, case-insensitive and plural-tolerant", () => {
    expect(pickCandidateForRequest("plan for a BAR STOOL push", all)).toEqual(BAR_STOOLS);
    expect(pickCandidateForRequest("plan for sofa sales", all)).toEqual(SOFAS);
    expect(pickCandidateForRequest("plan for barstools", all)).toBeNull();
    expect(pickCandidateForRequest("plan for footstools", [candidate("Stools", "stools")])).toBeNull();
  });

  it("gives null when no candidate's name is in the request", () => {
    expect(pickCandidateForRequest("plan for dining chairs", all)).toBeNull();
    expect(pickCandidateForRequest("plan for dining chairs", [])).toBeNull();
  });
});

describe("resolveRequestedCategory", () => {
  it("uses a loaded category without scanning", async () => {
    const loaded = categoriesFromServices(getDemoStore().clientServices.filter((s) => s.client_id === CT));
    const scan = vi.fn();
    const out = await resolveRequestedCategory({ request: STRATEGY_ASK, loaded, kind: "strategy", scan });
    expect(out).toEqual({ kind: "loaded" });
    expect(scan).not.toHaveBeenCalled();
  });

  it("doesn't scan when the request names no category", async () => {
    const scan = vi.fn();
    const out = await resolveRequestedCategory({ request: "Plan to hit 10x ROAS on $500/day", loaded: [], kind: "strategy", scan });
    expect(out).toEqual({ kind: "none" });
    expect(scan).not.toHaveBeenCalled();
  });

  it("matches a scanned candidate, or says what it couldn't find", async () => {
    const scan = vi.fn().mockResolvedValue({ candidates: [BLACK_BAR_STOOLS, BAR_STOOLS], source: "firecrawl" });
    expect(await resolveRequestedCategory({ request: STRATEGY_ASK, loaded: [], kind: "strategy", scan })).toEqual({
      kind: "matched",
      phrase: "bar stools",
      candidate: BAR_STOOLS,
    });
    scan.mockResolvedValue({ candidates: [BLACK_BAR_STOOLS], source: "firecrawl" });
    expect(await resolveRequestedCategory({ request: STRATEGY_ASK, loaded: [], kind: "strategy", scan })).toEqual({
      kind: "not_found",
      phrase: "bar stools",
    });
  });
});

describe("cachedSiteScan", () => {
  it("scans a client's site once per 24 hours", async () => {
    vi.mocked(scanSiteCandidates).mockResolvedValue({ candidates: [BAR_STOOLS], source: "firecrawl" });
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    await cachedSiteScan(CT, SITE, []);
    now.mockReturnValue(1_000_000 + 23 * 3_600_000);
    expect((await cachedSiteScan(CT, SITE, [])).candidates).toEqual([BAR_STOOLS]);
    expect(scanSiteCandidates).toHaveBeenCalledTimes(1);
    // Another site for the same client is its own entry.
    await cachedSiteScan(CT, "https://other.example", []);
    expect(scanSiteCandidates).toHaveBeenCalledTimes(2);
    now.mockReturnValue(1_000_000 + 25 * 3_600_000);
    await cachedSiteScan(CT, SITE, []);
    expect(scanSiteCandidates).toHaveBeenCalledTimes(3);
  });

  it("doesn't remember a failed scan", async () => {
    vi.mocked(scanSiteCandidates).mockResolvedValue({ candidates: [], source: "unavailable", reason: "scan_failed" });
    await cachedSiteScan(CT, SITE, []);
    await cachedSiteScan(CT, SITE, []);
    expect(scanSiteCandidates).toHaveBeenCalledTimes(2);
  });
});

describe("strategy ask for a category that isn't set up (DEMO_MODE)", () => {
  it("adds Bar Stools from the site scan, says so, and plans on it", async () => {
    noCategories([BAR_STOOLS, BLACK_BAR_STOOLS]);
    const gathered = await gatherDiagnoseEvidence({ clientId: CT, request: STRATEGY_ASK, intent: "strategy" });

    const added = ctServices();
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      name: "Bar Stools",
      landing_page_url: `${SITE}/collections/bar-stools`,
      source: "site_scan",
      is_active: true,
    });
    expect(gathered.evidence).toContain(ADDED_LINE);
    expect(gathered.evidence).toContain("- Planned only for: Bar Stools");
    expect(gathered.strategyPlanBuilt).toBe(true);
    expect(scanSiteCandidates).toHaveBeenCalledWith(expect.objectContaining({ siteUrl: SITE }));
  });

  it("doesn't scan again on the next question", async () => {
    noCategories([SOFAS]);
    await gatherDiagnoseEvidence({ clientId: CT, request: STRATEGY_ASK, intent: "strategy" });
    await gatherDiagnoseEvidence({ clientId: CT, request: STRATEGY_ASK, intent: "strategy" });
    expect(scanSiteCandidates).toHaveBeenCalledTimes(1);
  });

  it("adds nothing and says what it couldn't find when the site has no such category", async () => {
    noCategories([BLACK_BAR_STOOLS, SOFAS]);
    const gathered = await gatherDiagnoseEvidence({ clientId: CT, request: STRATEGY_ASK, intent: "strategy" });
    expect(ctServices()).toEqual([]);
    expect(gathered.evidence).toContain(`Couldn't find "bar stools" on ${SITE}; add it on the Services tab.`);
    expect(gathered.evidence).not.toContain("Added **");
  });

  it("never scans when a loaded category already matches", async () => {
    const before = ctServices().length;
    const gathered = await gatherDiagnoseEvidence({ clientId: CT, request: STRATEGY_ASK, intent: "strategy" });
    expect(scanSiteCandidates).not.toHaveBeenCalled();
    expect(ctServices()).toHaveLength(before);
    expect(gathered.evidence).not.toMatch(/Added \*\*|Couldn't find/);
  });

  it("never scans a strategy ask that names no category", async () => {
    noCategories([BAR_STOOLS]);
    await gatherDiagnoseEvidence({ clientId: CT, request: "Plan to hit 10x ROAS on $500/day", intent: "strategy" });
    expect(scanSiteCandidates).not.toHaveBeenCalled();
    expect(ctServices()).toEqual([]);
  });

  it("doesn't add a second row when the category is set up but switched off", async () => {
    const store = getDemoStore();
    for (const s of ctServices()) s.is_active = false;
    vi.mocked(scanSiteCandidates).mockResolvedValue({ candidates: [{ ...BAR_STOOLS, alreadyAdded: true }], source: "firecrawl" });
    const before = store.clientServices.length;
    const gathered = await gatherDiagnoseEvidence({ clientId: CT, request: STRATEGY_ASK, intent: "strategy" });
    expect(store.clientServices).toHaveLength(before);
    expect(gathered.evidence).toContain("**Bar stools** is switched off on the Services tab");
  });
});

describe("category-spend ask for a category that isn't set up (DEMO_MODE)", () => {
  it("adds Bar Stools and answers the spend question on it", async () => {
    noCategories([BAR_STOOLS, BLACK_BAR_STOOLS]);
    const gathered = await gatherDiagnoseEvidence({ clientId: CT, request: SPEND_ASK, intent: detectRequestIntent(SPEND_ASK) });
    expect(ctServices().map((s) => s.name)).toEqual(["Bar Stools"]);
    expect(gathered.evidence).toContain(ADDED_LINE);
    expect(gathered.evidence).toContain("### Spend & return by category");
  });

  it("adds nothing and says what it couldn't find", async () => {
    noCategories([SOFAS]);
    const gathered = await gatherDiagnoseEvidence({
      clientId: CT,
      request: "How much have we spent on bar stools?",
      intent: "general",
    });
    expect(ctServices()).toEqual([]);
    expect(gathered.evidence).toContain(`Couldn't find "bar stools" on ${SITE}; add it on the Services tab.`);
  });
});
