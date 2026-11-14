import { describe, expect, it } from "vitest";
import { fetchMetaAuditSnapshot } from "@/lib/audit/meta-audit-data";

/**
 * Black Tie Classic, 14 Nov 2026: a lead-form campaign whose insights came back with NO `results`
 * field ("Unknown Optimization Goal"), and with the same 83 leads under both `lead` and
 * `onsite_conversion.lead_grouped`. The audit showed "Results: not reported" and 166 leads.
 */
const btcRow = {
  spend: "963.71",
  impressions: "54542",
  reach: "22157",
  frequency: "2.46",
  inline_link_click_ctr: "1.03",
  inline_link_clicks: "563",
  actions: [
    { action_type: "offsite_complete_registration_add_meta_leads", value: "83" },
    { action_type: "link_click", value: "563" },
    { action_type: "lead", value: "83" },
    { action_type: "onsite_conversion.lead_grouped", value: "83" },
    { action_type: "onsite_conversion.messaging_conversation_started_7d", value: "4" },
  ],
};

function graphReturning(row: Record<string, unknown>) {
  return {
    get: async <T,>(path: string, params: Record<string, unknown> = {}): Promise<T> => {
      if (path === "act_1") return { name: "BTC", currency: "AUD", timezone_name: "Australia/Sydney", account_status: 1 } as T;
      if (path === "act_1/campaigns") return { data: [{ id: "c1", name: "TR | Lead Gen", objective: "OUTCOME_LEADS", effective_status: "ACTIVE" }] } as T;
      if (path === "act_1/insights" && params.level === "account" && !params.time_increment && !params.breakdowns) return { data: [row] } as T;
      if (path === "act_1/insights" && params.level === "campaign" && !params.time_increment && !params.breakdowns) {
        return { data: [{ ...row, campaign_id: "c1" }] } as T;
      }
      return { data: [] } as T;
    },
  };
}

describe("counting leads", () => {
  it("counts each lead once, not once per Meta action that reports it", async () => {
    const snap = await fetchMetaAuditSnapshot(graphReturning(btcRow), "act_1", { since: "2026-10-16", until: "2026-11-14", compare: false });
    expect(snap.totals!.leads).toBe(83);
  });

  it("falls back to the leads when Meta returns no result type, instead of 'not reported'", async () => {
    const snap = await fetchMetaAuditSnapshot(graphReturning(btcRow), "act_1", { since: "2026-10-16", until: "2026-11-14", compare: false });
    expect(snap.totals).toMatchObject({ results: 83, resultLabel: "Leads", costPerResultCents: 1161 });
    expect(snap.campaigns[0]!.performance).toMatchObject({ results: 83, resultLabel: "Leads" });
  });

  it("keeps Meta's own result when it sends one", async () => {
    const row = { ...btcRow, results: [{ indicator: "actions:onsite_conversion.lead_grouped", values: [{ value: "80" }] }] };
    const snap = await fetchMetaAuditSnapshot(graphReturning(row), "act_1", { since: "2026-10-16", until: "2026-11-14", compare: false });
    expect(snap.totals).toMatchObject({ results: 80, resultLabel: "Leads" });
  });

  it("counts add-to-carts and checkouts once (Meta's omni_ total already includes the plain action)", async () => {
    // Gift Packaging, 17 Aug – 14 Nov 2026: omni_add_to_cart 2,131 and add_to_cart 2,131 were shown as 4,262.
    const row = {
      ...btcRow,
      actions: [
        { action_type: "omni_add_to_cart", value: "2131" },
        { action_type: "add_to_cart", value: "2131" },
        { action_type: "omni_initiated_checkout", value: "787" },
        { action_type: "initiate_checkout", value: "787" },
        { action_type: "landing_page_view", value: "206" },
      ],
    };
    const snap = await fetchMetaAuditSnapshot(graphReturning(row), "act_1", { since: "2026-10-16", until: "2026-11-14", compare: false });
    expect(snap.totals).toMatchObject({ addToCart: 2131, initiateCheckout: 787 });
  });

  it("guesses nothing when the row has both purchases and leads but no result type", async () => {
    const row = { ...btcRow, actions: [...btcRow.actions, { action_type: "omni_purchase", value: "5" }] };
    const snap = await fetchMetaAuditSnapshot(graphReturning(row), "act_1", { since: "2026-10-16", until: "2026-11-14", compare: false });
    expect(snap.totals!.results).toBeNull();
  });
});
