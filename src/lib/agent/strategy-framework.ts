/**
 * How the writer turns the plan engine's evidence into the three-level
 * strategy report (where you are / how it compares / the plan). The numbers
 * come from src/lib/strategy/plan.ts via render.ts; this text only says how to
 * present them.
 */
export const STRATEGY_FRAMEWORK = `
# Strategy report method

Use only numbers from the evidence: budgets, spend, revenue, ROAS, coverage, scores and benchmarks. If a number is not in the evidence, say it is not available. Never estimate one.
Use the **Word for offerings** from "Strategy inputs" ("category" or "service") everywhere you would say category or service, including in headings.
This is a recommendation only. Do not queue or execute anything, propose no tool JSON, and do not say anything in Meta was changed.
Google figures are read-only. Never say this tool changed Google or will change Google: any Google budget is a recommendation for the Google Ads account.
If the evidence has "Channel data", put its notes and warnings (for example "Google needs reconnecting", a currency mismatch or a Google part that failed to load) at the top of Level 1. If it has "Scope", say the plan covers only those categories.

## Required report format (these headings, in this order)
1. **Bottom line**: can this budget hit this target, and what's the honest gap. Give the daily budget, the target ROAS, the plan's blended ROAS from "Plan total", and the Level 2 verdict in two or three sentences. When "Strategy inputs" has a "Total budget", give it with its period (and say when the period was assumed), and give the "Plan over the period" spend and projected revenue against its target.
2. **Level 1: where you are**: spend, revenue and ROAS by category from the Level 1 table, the account audit score, unmatched spend, coverage % and the ad-level spend covered. Name the untouched categories. If Level 1 says the figures are partial, say so first and call those categories "not seen in the loaded ads", never "no spend".
   - When the table has GA4 revenue, use the GA4 figures (Meta + Google spend, combined ROAS and its basis) and name the method from the "GA4 method" line. A landing-page method is an estimate, not exact product sales: say so. The ROAS is on GA4 paid revenue (paid social + paid search sessions); "GA4 revenue (all channels)" also counts organic, direct and email sales, so quote it for reference only, never as a return on ad spend. Give the Google Ads unmatched spend, and any GA4 revenue not matched to a category, too. When Level 1 has "GA4 … revenue by platform" lines, give each category's Meta, Google and other-channel GA4 revenue and how it was matched, and pass on any UTM-tag check it names.
3. **Level 2: how it compares**: name the reference and its source from the Level 2 table, and say what the verdict means. Then show two routes side by side (a two-column table works):
   - **External:** what competitors run, taken from the competitor brief highlights in the client context. If there are none, say so.
   - **Internal:** the client's own categories with no spend ("Untouched") and the Meta capabilities marked "Not used", each with its reason, plus the Google campaign types not used or needing a product feed when the evidence lists them.
   - When the evidence has "Level 2: GA4 vs platform-reported", give Meta-reported revenue against GA4 revenue from Facebook/Instagram paid sessions and the gap in %. When it has "Search demand", give the categories with the most search impressions and their top queries.
4. **Level 3: the plan**:
   - The allocation table: category, tier, daily budget, target ROAS, projected daily revenue.
   - When the evidence has "Level 3: channel split", show the Meta budget and Google budget per funded category, the projection per channel, the Google campaign types, and the totals, then this line as written: "Google budget is a recommendation for the Google Ads account — this tool doesn't change Google." If it gives a reason instead of a table, say there is no Meta and Google split and why.
   - Campaign structure per tier, from "Structure per tier".
   - A creative plan: at least 3 new concepts a month for each funded category, built from the competitor patterns.
   - What to track weekly: spend, revenue and ROAS for each category against its target ROAS, the metrics the Level 1 table already reports.
   - If the evidence says "No budget allocated", say that plainly with its reason and what has to change. Do not invent an allocation.
5. **Stretch scenarios**: one line per scenario, labelled with its target. Some may sit below the main target; say so.
6. **What would make this plan better**: the missing data, for example margins not set, categories not loaded, low coverage, no GA4 or catalogue connected yet. Take these from the inputs and assumptions.
7. **One next step**: the category, daily budget and duration from "Next test". If it says there is no test to run, say what has to change first.
`.trim();
