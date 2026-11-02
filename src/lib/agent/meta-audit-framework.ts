/**
 * Meta Ads audit method for the writer. Built on three specialist playbooks:
 *  - Tracking & measurement: bad tracking is worse than none — it actively
 *    misleads bidding. Verify before judging performance.
 *  - Paid media auditor: every finding has severity, evidence, a specific fix
 *    and projected impact; executive summary for non-practitioners.
 *  - Paid social strategist: full funnel, CBO vs ABO, frequency by funnel
 *    stage, creative testing velocity, audience exclusions.
 *
 * Deterministic checks live in src/lib/audit/checkpoints.ts; this text tells
 * the writer how to interpret them alongside the rest of the evidence.
 */
export const META_AUDIT_FRAMEWORK = `
# Meta Ads audit method

Cite live evidence (spend, results, cost per result, CTR, frequency, statuses) in the account currency. Never invent metrics — if something wasn't measured, say "not verified" and what to check.

Report only what the operator asked for — add comparisons, trends or extra periods only when asked.

## What goes in the report, and what doesn't
- **Only what this account's data shows.** A finding exists because a number, status or setting in the evidence is wrong — not because a typical audit would mention it. If an area is fine, it is a one-line strength or nothing; never pad a section to fill the format, and never raise a hygiene point (unused pixels, idle audiences, naming, archiving) unless it is actually hurting delivery or tracking here.
- **Every claim traces to this run's evidence.** If a number, name, date or cause isn't in the evidence, don't state it. A likely cause is a hypothesis: say what in the data points to it and what to check, and don't present it as fact.
- **Never reason from budget × days.** Budgets change mid-period, so spend that doesn't match the current budget is not an anomaly you can call out from arithmetic. Check the change history; if an edit explains it, say so, and if nothing does, say it is unexplained.
- **Say each thing once.** Every problem is written out in full in exactly one place — Risks & Issues — with its evidence and fix. Everywhere else, mention it only as far as that section needs, in a few words, and point to it ("R1"). Concretely: the Executive Summary names the biggest issues in one line each and doesn't explain mechanisms; Tracking says what is and isn't being measured and points to the risk; ad set verdicts give their own numbers and a verdict and point to the risk rather than repeating its cause; Landing Pages covers only what is specific to the page; Recommendations are actions with impact, effort and timing and don't re-argue the evidence; Next Steps is one sentence. A reader who reads the report top to bottom should never meet the same explanation twice. What's Working lists real strengths once, and doesn't repeat a point a risk or the checklist already makes. Number the issues in the Risks table (R1, R2…) so other sections can point to them.

## Order of work
1. **Tracking first.** If the "Audit checkpoint scorecard" shows tracking failures (T-codes), state up front that performance numbers can't be trusted until they're fixed: a conversion that isn't recorded doesn't just lose data, it teaches Meta's algorithm to find the wrong people.
2. **Structure and delivery** — is anything able to deliver (campaign on, ad set on, approved ads), learning phase, budget concentration.
3. **Efficiency** — spend, results, cost per result, ROAS by campaign/ad set; winners to scale and losers to cut.
4. **Funnel, audiences and creative** — prospecting vs retargeting, exclusions, frequency, creative testing.
5. **Landing pages** — message match and conversion path for each destination.

## Lenses and benchmarks
### Tracking & measurement
- The event each ad set optimises for must fire (Events Manager), ideally from both the pixel and the Conversions API with a shared event_id so Meta de-duplicates.
- Events should carry customer information (email/phone/fbc/fbp) — aim for 70%+ of conversion events.
- One attribution setting across ad sets you compare (usually 7-day click + 1-day view).
- Events firing on the site but 0 results on ads = attribution break (wrong domain, pixel not on the thank-you page, conversions coming from other channels).

### Structure, bidding & budget (auditor)
- Fewer, larger ad sets beat many small ones: each needs ~50 optimisation events/week to exit learning. "Learning limited" = consolidate, raise budget, or optimise for a higher-volume event.
- CBO (campaign budget) when ad sets compete for the same goal; ABO only for deliberate tests.
- Cost/bid caps set below market choke delivery.
- Significant edits reset learning — batch changes.

### Funnel, audiences & creative (paid social strategist)
- Full funnel: prospecting → engagement → retargeting → retention. Retargeting harvests demand prospecting creates; >50% of spend on retargeting shrinks the pool.
- Healthy 7-day frequency: 1.5–2.5 prospecting, 3–5 retargeting. Above that, refresh creative or widen the audience.
- Exclude customers/converters from prospecting so budget reaches new people.
- Test 3–5 genuinely different creative concepts a month; 2–6 live ads per ad set; mix formats (vertical video, static, carousel).
- Ecommerce ROAS guide: 1.5×+ prospecting, 3×+ retargeting (check margins).
- Link CTR under ~0.7% usually means a weak hook or offer.

## Changes during the period
The evidence includes Meta's account activity history for the audited days: every edit anyone (or any app) made, and the day-by-day numbers of what was edited. Your job is to understand what changed and whether it mattered, then tell the operator in whatever shape fits this account. There is no fixed layout for this section — a short paragraph when little happened, grouped by campaign or by day when a lot did, a table only if a table is genuinely the clearest way to show it. Don't force a template.

How to read it:
- **What an edit is.** Turning things on/off (campaign, ad set, ad status), budget and schedule changes, bid strategy or cap changes, optimisation goal / pixel / conversion event changes, targeting and audience changes, placement changes, creative and ad copy edits, new ads or ad sets, deleted objects, and tracking edits (pixel, custom conversion). Renames, notes and similar edits rarely change delivery — mention them in a clause or leave them out; never skip an edit that could have moved delivery, spend, audience, creative, the optimisation goal, tracking or status.
- **Why edits matter.** Meta resets an ad set's learning phase after a significant edit (a large budget change, new targeting, a new or edited creative, a change of bid strategy or optimisation event, or being paused for a long stretch), and results are unstable for roughly the next 3–7 days. So an edit near the start or middle of a short window can explain weak or zero results, a cost spike or an odd spend pattern better than the audience or creative does.
- **Who and how.** Say who made each meaningful edit when Meta reports it, and whether it came through an app or integration rather than a person. If the actor isn't reported, say that — don't guess.
- **Link edits to numbers carefully.** Use the delivery-by-day lines: compare the days before and after an edit, and say what moved (spend, results, cost per result, CTR). Keep it honest: "followed" or "coincided with", not "caused", unless the evidence proves it; allow for weekday effects and learning; and treat movement on a handful of results (under ~20–30) as directional, not a conclusion. If there are no day-by-day lines for an edit, describe the edit without claiming an effect.
- **Fold it into the findings.** When an edit explains something wrong elsewhere (a learning reset behind 0 results, a budget cut behind lower spend, a paused ad behind thin creative rotation, a tracking edit behind an attribution break), make that connection in the one place the problem is written up and refer back here rather than telling the story twice.
- **Edge cases.** If the history couldn't be read, say that plainly — never write that nothing changed. If it loaded and is empty, one line is enough. If it may be incomplete, say so. Only the audited days count; don't import earlier edits.

## Severity
- **Critical** — money is being wasted right now or nothing can deliver (tracking broken on the optimisation event, account/campaign can't deliver, spending limit about to stop ads).
- **High** — large efficiency loss (attribution break, learning limited on major spend, rejected ads in live campaigns, ROAS under target).
- **Medium** — structural weakness (no retargeting, missing exclusions, high frequency, mixed attribution, thin creative testing).
- **Low** — hygiene (naming, archiving, unused pixels/audiences).

## Required report format (keep these headings, in this order)
# Meta Ads Account Audit — <account name>
1. **Executive Summary** — 3–5 bullets in plain business language for a non-specialist, each a different point: overall score from the scorecard, the biggest money leak (with the spend at stake), any edit made in the period that matters, and the first fix. One line each — the explanation lives in Risks & Issues.
2. **Account Snapshot** — period, total spend, results, cost per result (and ROAS if purchases), active vs paused campaigns.
   - **When the evidence says "Comparison: not requested"** (the operator didn't ask for one): give one set of numbers for the audited period from the "Totals:" line. No "vs previous" columns, no before → after, no trend / improved / declined / week-over-week language, and no "previous period" anywhere in the report; the "Period:" line shows only the audited period.
   - **When the evidence has a "Totals vs previous period" / "Totals vs comparison period" line** (the operator asked to compare): add the change against the comparison period: spend, impressions, reach, frequency, CPM, link clicks, link CTR, results, cost per result, and ROAS / purchase value / landing page views when listed, each as before → after (±%).
     - Head the two columns with exactly the Current and Comparison dates in the evidence's "Current: … ; Comparison: …" line — never work out, shift or round the dates yourself.
     - Never write "not available" for a metric that is in a comparison line. If a comparison part "failed to load", say that part failed to load.
     - If the evidence says the periods differ in length, say the totals aren't like-for-like and compare the daily averages too.
   - **After the snapshot, under the sub-heading "### Changes during this period"**, cover what was edited in the audited days, following "Changes during the period" above. It sits inside section 2 so the numbered sections keep their numbers.
3. **Tracking & Measurement** — what is and isn't being measured, from the T-checkpoints, in plain words. Where a tracking problem is also a risk, say what's measured and point to the risk (e.g. "see R1") instead of re-explaining it. If tracking is sound, say so in a line.
4. **Active Campaigns** — table: campaign, status, budget, spend, results, cost per result, CTR, frequency. Then, for each audited campaign, a "### Ad sets in <campaign name>" sub-section (no IDs in that heading):
   - table (these 9 columns only, so it fits a printed page): Ad set | Status | Learning | Spend | Results | Cost per result | CTR | Freq (7d) | Live ads
   - one verdict per ad set — **Scale / Keep / Fix / Pause** — as a bullet: "**<ad set name>** (ID <id>) · <budget> · optimises for <event in plain words, e.g. Complete registration> — <verdict>: <reason>", with the numbers behind it (share of campaign spend, cost per result vs the campaign, learning limited, frequency over benchmark, too few live ads, setup gaps such as no exclusions or restricted placements). Mention a trend against the comparison period only when the evidence has comparison lines ("vs previous period" / "vs comparison period").
5. **What's Working** — real strengths with their evidence, each a point not already made elsewhere in the report.
6. **Risks & Issues** — table: Severity | Issue | Evidence | Fix | Spend at stake. Put R1, R2… at the start of each Issue so other sections can point to it. This is the one place each problem is explained in full. Most severe first; within a severity, most spend at stake first. In Evidence, give the likely cause, not only the symptom ("link CTR 0.5% with 7-day frequency at 4.1 on a prospecting ad set: creative fatigue", not "low CTR"), using the cause chain in "Diagnosing performance".
7. **Landing Pages** — own destinations (+ competitor pages if provided): score, message match, and fixes specific to the page. A tracking problem already in Risks is pointed to, not repeated.
8. **Prioritised Recommendations** — table: # | Action | Expected impact | Effort | When (This week / Next 30 days). Actions only: don't restate the evidence from Risks, and don't list two actions for the same fix.
9. **Next Steps** — one sentence: the single highest-impact action; recommendations only, no changes made.

The detailed "Audit checklist" table is appended automatically after your report — don't reproduce it. It is the only place passed checks are listed in full.

## Rules
- Recommendations only until the operator explicitly asks to change something.
- Every Risk and Recommendation must have a specific fix — never "consider reviewing".
- Quantify impact with real numbers from the evidence (spend at stake, results lost); if you estimate, say it's an estimate and why.
- Never invent competitor claims; only use scraped competitor landing-page evidence.
- Join the findings up: when several checks point at one root cause (e.g. tracking gaps explaining "poor" cost per result, or one fatigued ad set dragging a campaign), say so once and fix the cause, rather than listing each symptom as its own issue.
- Flag low-volume reads: a cost per result on fewer than ~20–30 results is directional; say so rather than giving a confident Scale or Pause verdict on it.
- Recommendations follow the sensible order: tracking, then offer and landing page, then creative, then audience, then bidding and budget. Budget increases go in steps of about 20–30% every 3–4 days.
- Work out the findings before you start writing: the Executive Summary comes first in the report but must state the real biggest issue and the money behind it, matching the Risks table.
`.trim();
