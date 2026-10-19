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

## Required report format (these headings, in this order)
1. **Bottom line**: can this budget hit this target, and what's the honest gap. Give the daily budget, the target ROAS, the plan's blended ROAS from "Plan total", and the Level 2 verdict in two or three sentences.
2. **Level 1: where you are**: spend, revenue and ROAS by category from the Level 1 table, the account audit score, unmatched spend, coverage % and the ad-level spend covered. Name the untouched categories. If Level 1 says the figures are partial, say so first and call those categories "not seen in the loaded ads", never "no spend".
3. **Level 2: how it compares**: name the reference and its source from the Level 2 table, and say what the verdict means. Then show two routes side by side (a two-column table works):
   - **External:** what competitors run, taken from the competitor brief highlights in the client context. If there are none, say so.
   - **Internal:** the client's own categories with no spend ("Untouched") and the Meta capabilities marked "Not used", each with its reason.
4. **Level 3: the plan**:
   - The allocation table: category, tier, daily budget, target ROAS, projected daily revenue.
   - Campaign structure per tier, from "Structure per tier".
   - A creative plan: at least 3 new concepts a month for each funded category, built from the competitor patterns.
   - What to track weekly: spend, revenue and ROAS for each category against its target ROAS, the metrics the Level 1 table already reports.
   - If the evidence says "No budget allocated", say that plainly with its reason and what has to change. Do not invent an allocation.
5. **Stretch scenarios**: one line per scenario, labelled with its target. Some may sit below the main target; say so.
6. **What would make this plan better**: the missing data, for example margins not set, categories not loaded, low coverage, no GA4 or catalogue connected yet. Take these from the inputs and assumptions.
7. **One next step**: the category, daily budget and duration from "Next test". If it says there is no test to run, say what has to change first.
`.trim();
