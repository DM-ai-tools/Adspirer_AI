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
- **Say each thing once.** Every problem is written out in full in exactly one place — Risks & Issues — with its evidence and fix. Everywhere else, mention it only as far as that section needs, in a few words, and point to it ("R1"). Concretely: the Executive Summary names the biggest issues in one line each and doesn't explain mechanisms; Tracking says what is and isn't being measured and points to the risk; ad set verdicts give their own numbers and a verdict and point to the risk rather than repeating its cause; Landing Pages is a short table of what is specific to each page; Recommendations are actions with impact, effort and timing and don't re-argue the evidence; Next Steps is one sentence. A reader who reads the report top to bottom should never meet the same explanation twice. The strongest thing working gets one Executive Summary bullet with its number. Number the issues in the Risks table (R1, R2…) so other sections can point to them.

## How to present it (the reader is a client and Meta specialists — it must scan in seconds)
- **Points, not paragraphs.** Everything is a short bullet or a labelled line. No paragraph longer than two sentences anywhere; if you are about to write one, split it into bullets. Lead each bullet with the point in bold, then the evidence.
- **Tables are for numbers only.** Use a table only when every cell is a number, a date, a status or 1–3 words (the account snapshot, the ad set table, the recommended structure). **Never put sentences in table cells** — text in narrow columns is unreadable once printed. Anything with an explanation (a risk, a recommendation, a change, a verdict) is a card: a bold title line, then one labelled bullet per field.
- **One idea per bullet, one line where possible.** Put numbers first ("CPA $42 vs $25 target"), the reason after.
- **Plain business words.** Spell out jargon the first time (learning limited = Meta hasn't got enough results to optimise). Use ✅ / ⚠️ / ❌ sparingly to mark a verdict, never as decoration.
- **Same shape every time**, so the reader learns it once: Risks, Recommendations and Changes each use their card layout below for every item.

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

### Catalogue (Commerce Manager)
Applies only when the evidence has a "Catalogue (Commerce Manager)" section (the audited ad sets sell from a product catalogue). Without it, skip this lens and the catalogue heading in the report.
- The section is live Meta data. Report its findings as given: severity, title and the numbers in the evidence lines. Never add catalogue problems it doesn't list.
- A catalogue problem matters through the ad sets that sell from it: too few in-stock items, a stale or erroring feed, items Meta says must be fixed, and pixel events that don't match catalogue items all starve dynamic ads of products or signal.
- **Learning links.** Each learning-limited ad set is linked to its product set. When the link says likely contributor, name the catalogue reasons it lists as one cause of the learning problem, next to the usual ones (budget, event volume, edits). When the link says healthy, say the catalogue is not the cause and point to the other lenses (budget vs event volume, audience, recent edits); never blame the catalogue for it.
- If the section says "Catalogue not read", say the catalogue was not checked and why; never guess catalogue health.

## Changes during the period
The evidence includes Meta's account activity history for the audited days: every edit anyone (or any app) made, plus — for each edited campaign, ad set and the whole account — its status, its scheduled start and end dates, and its numbers for the days before, the day of and the days after each edit. Your job is to say what changed and **whether each meaningful change was justified or a wrong call**, using those numbers.

How to read it:
- **What an edit is.** Turning things on/off (campaign, ad set, ad status), budget and schedule changes, bid strategy or cap changes, optimisation goal / pixel / conversion event changes, targeting and audience changes, placement changes, creative and ad copy edits, new ads or ad sets, deleted objects, and tracking edits. Renames, notes and similar edits rarely change delivery — a single line or leave them out; never skip an edit that could have moved delivery, spend, audience, creative, the optimisation goal, tracking or status.
- **Why edits matter.** Meta resets an ad set's learning phase after a significant edit (a large budget change, new targeting, a new or edited creative, a change of bid strategy or optimisation event, or a long pause), and results are unstable for roughly 3–7 days. An edit near the start or middle of a short window can explain weak or zero results better than the audience or creative does.
- **Who and how.** Say who made each meaningful edit when Meta reports it, and whether it came through an app. If the actor isn't reported, say that — don't guess.
- **Judging an edit (the verdict).** Compare the "before", "day of" and "after" figures for that object:
  - **✅ Justified** — the reason for the edit shows in the numbers before it (e.g. a paused ad set that was spending with no results; a budget raised on a winner at or beating its cost target; a disapproved ad replaced) and the after-figures held or improved.
  - **❌ Wrong call** — the edit cut against the numbers or hurt them (e.g. a budget cut or pause on an ad set that was converting well; a big budget jump or creative swap that reset learning and was followed by worse cost per result or lost results; budget raised on something already losing money).
  - **⚠️ Inconclusive** — too few results to tell (under ~20–30), another edit landed in the same window, the "after" window is mostly outside the period, or movement is within normal day-to-day swing. Say which.
  - Always give the numbers that led you there, and say "followed" or "coincided with", not "caused", unless the evidence proves it. Allow for weekday effects and learning. If there are no figures around an edit, say the verdict can't be given and why — never invent one.
- **Fold it into the findings.** When an edit explains a problem elsewhere (a learning reset behind 0 results, a paused ad behind thin creative rotation, a tracking edit behind an attribution break), write the problem up once in Risks and point to this change.
- **Edge cases.** If the history couldn't be read, say that plainly — never write that nothing changed. If it loaded and is empty, one line is enough. If it may be incomplete, say so. Only the audited days count; don't import earlier edits.
- **A lot of edits (dozens or hundreds).** Don't list them all. Give a one-line count by kind ("412 edits: 120 ad status, 80 creative, …"), then cards for the 5–10 that mattered most, then one line for the rest ("N routine edits: renames, ad status flips with no effect on delivery").

## Breakdowns
The evidence has a "Breakdowns" section: sums of Meta's own rows by creative format, destination page, audience type, placement position, age and gender, plus the settings in use. Use it to answer "what works and what has never been tried" from numbers, not from habit.
- **Report only splits with a real difference.** Name a winner only when both groups have enough results to read (~20–30) or the gap is large on a decent spend; otherwise say the split is too thin to judge. A split that shows nothing is one line or left out.
- **Use the account's own goal metric.** For a sales account judge on cost per result, ROAS or purchases as given; if the account reports add to cart, cost per add to cart and add-to-cart rate may be shown as a leading signal but never as a stand-in for sales.
- **Say what each grouping is.** Audience type comes from what an ad set includes, not its name; "no saved audience" is broad or interest-based and you must not pick one. Destination comes from the ad link; where Meta didn't return one, say the share of spend that is unread and that the link must be checked in Ads Manager.
- **"Never tried" is limited to this period.** From "Settings in use" you can say what was used in the audited period (bid strategy, optimisation goal, attribution window, Advantage+, automatic placements). You cannot say it was never used before. Frame an untested option as "not used in the audited period" and a test to run, never as a failure.
- **Reconcile.** If the evidence says some spend isn't attributed to a listed ad, say so in one line; don't let the split tables imply they cover the whole account.
- **Attribution matters.** Where the evidence gives purchases, say which attribution window they are counted in (from "Settings in use"); results that include view-through are Meta's own claim and not proof the ad caused the sale.

## Severity
- **Critical** — money is being wasted right now or nothing can deliver (tracking broken on the optimisation event, account/campaign can't deliver, spending limit about to stop ads).
- **High** — large efficiency loss (attribution break, learning limited on major spend, rejected ads in live campaigns, ROAS under target).
- **Medium** — structural weakness (no retargeting, missing exclusions, high frequency, mixed attribution, thin creative testing).
- **Low** — hygiene (naming, archiving, unused pixels/audiences).

## Required report format (keep these headings, in this order)
The report is read by a client and by Meta specialists, printed. **Less text, more information:** a table or a labelled line beats a sentence, and nothing is said twice. No section may be padded to fill the format.

# Meta Ads Account Audit — <account name>
1. **Executive Summary** — 3–5 one-line bullets for a non-specialist, each a different point: overall score from the scorecard, the biggest money leak (with the spend at stake), the strongest thing working (with its number), any edit in the period that matters, and the first fix. The explanation lives in Risks & Issues.
2. **Account Snapshot** — one line with the period and active vs paused campaigns, then a **Metric | Value** table (two columns exactly; it prints as a row of tiles) with every metric on the "Totals:" line, for any kind of business — leave none out. That means spend, **sales revenue (purchase value)**, ROAS, purchases, cost per purchase, average order value, results, cost per result, impressions, reach, frequency, CPM, link clicks, link CTR, cost per link click, clicks (all), landing page views, add to cart, initiate checkout, leads, cost per lead and video plays — whichever of these the line lists. Sales revenue always gets its own row for a sales account. Don't swap a metric the line gives for a different one, and don't round away or merge rows. A metric the Totals line doesn't list wasn't reported: for sales revenue say "no purchase value reported" (a lead-gen or awareness account may have none); for any other, leave the row out rather than guess. Never write a number that isn't on the line.
   - **When the evidence says "Comparison: not requested"** (the operator didn't ask for one): give one set of numbers for the audited period from the "Totals:" line. No "vs previous" columns, no before → after, no trend / improved / declined / week-over-week language, and no "previous period" anywhere in the report; the "Period:" line shows only the audited period.
   - **When the evidence has a "Totals vs previous period" / "Totals vs comparison period" line** (the operator asked to compare): use a **Metric | <Current dates> | <Comparison dates> | Change** table instead, for every metric on that line — spend, sales revenue (purchase value), ROAS, purchases, impressions, reach, frequency, CPM, link clicks, link CTR, results, cost per result, landing page views, add to cart, initiate checkout, leads and any other it lists — the change as ±%.
     - Head the two date columns with exactly the Current and Comparison dates in the evidence's "Current: … ; Comparison: …" line — never work out, shift or round the dates yourself.
     - Never write "not available" for a metric that is in a comparison line. If a comparison part "failed to load", say that part failed to load.
     - If the evidence says the periods differ in length, say the totals aren't like-for-like and compare the daily averages too.
   - **After the snapshot, under the sub-heading "### Changes during this period"**, cover what was edited in the audited days, following "Changes during the period" above. It sits inside section 2 so the numbered sections keep their numbers. Open with one bullet: how many edits, and the tally of verdicts (e.g. "412 edits · 6 reviewed: 2 ✅ justified, 3 ❌ wrong call, 1 ⚠️ inconclusive"). Then one card per meaningful change, exactly this shape:

     **<date> — <what was changed>: <object name>** (<campaign / ad set / ad / account>)
     - **Who:** <person or app, or "not reported">
     - **Ran:** <scheduled start date> → <end date, or "no end date set"> · status now <status>
     - **Numbers that day:** day of the edit — spend, results, cost per result, CTR (and revenue / ROAS for sales accounts)
     - **Before → after:** 3 days before vs 3 days after, same metrics, as "before → after"
     - **Verdict:** ✅ Justified / ❌ Wrong call / ⚠️ Inconclusive — one sentence with the figures behind it
     - **What to do:** only for ❌ — the one-line fix (e.g. restore the budget, re-test the creative on a fresh ad set)
3. **Performance Breakdown** — write the heading, then the line [[PERFORMANCE_TABLES]] on its own. The application replaces that line with the computed tables (month by month when the period spans several months, campaigns with their type and audience, audience types, ad formats, offer vs no offer, landing page type, placements, age and gender), each with a one-line "Read". **Never write those tables yourself.** Then a "### Summary" sub-heading with 3–6 one-line bullets, one per table that shows a real difference, each as "**<winner> vs <other>:** <metric> <a> vs <b>, <share of spend>" with the figures copied from the "Performance tables" evidence (cost per add to cart and add-to-cart rate are a leading signal, never a stand-in for sales). Close with one "**Not used in the audited period:**" bullet listing the options from "Settings in use" that were absent and are worth a test. A split that shows nothing is left out.
4. **Tracking & Measurement** — at most four bullets (✅ measured / ❌ not measured / ⚠️ weak), from the T-checkpoints. Where a tracking problem is also a risk, point to it ("see R1"). If tracking is sound, say so in one line.
5. **Ad Sets** — for each audited campaign, a "### Ad sets in <campaign name>" sub-section (no IDs in that heading):
   - table (these 9 columns only, so it fits a printed page): Ad set | Status | Learning | Spend | Results | Cost per result | CTR | Freq (7d) | Live ads
   - one verdict per ad set — **Scale / Keep / Fix / Pause** — as a bullet: "**<ad set name>** — <verdict>: <reason in under 15 words, with its numbers>", then the setup gaps (no exclusions, restricted placements, learning limited) in a few words. Point to a risk instead of re-explaining it. Mention a trend against the comparison period only when the evidence has comparison lines.
   - **Only when the evidence has a "Catalogue (Commerce Manager)" section**, close this section with a "### Catalogue (Commerce Manager)" sub-heading: one bullet per catalogue finding with its numbers and the ad sets it affects, then one bullet per learning-limited ad set saying whether the catalogue is a likely contributor or is not the cause. A real catalogue problem is written out in full once in Risks & Issues and pointed to from here.
6. **Landing Pages** — write the heading, then the line [[LANDING_PAGE_TABLES]] on its own. The application replaces it with every landing page that took spend in the period (ads, spend, share, link CTR and every funnel figure the account has, per page), then the checks for each page analysed (score, message match, mobile load time, PageSpeed, form fields, Meta pixel, UTMs kept through redirects, trust, call to action). **Never write those tables yourself.** Then one bullet per page with a problem: "**<page>** — <the problem, with its figure>: <the specific fix>". When most spend went to ads with no website link (messaging, call or lead-form ads), say so in one bullet and what that means for measuring results. A problem big enough to be a risk is written out in Risks and pointed to from here.
7. **Risks & Issues** — a one-line index first (e.g. "2 Critical · 3 High · 1 Medium"), then **one card per issue**, each opened by a ### heading, not a table:

   ### R1 · 🔴 Critical — <the issue in under 12 words>
   - **Evidence:** the numbers, and the likely cause rather than only the symptom ("link CTR 0.5% with 7-day frequency at 4.1 on a prospecting ad set: creative fatigue", not "low CTR"), using the cause chain in "Diagnosing performance". One line.
   - **Fix:** the specific action, one step per sub-bullet if there are several
   - **Spend at stake:** the amount, or "not quantifiable" and why

   Use 🔴 Critical, 🟠 High, 🟡 Medium, ⚪ Low. This is the one place each problem is explained in full. Most severe first; within a severity, most spend at stake first. Number them R1, R2… so other sections can point to them.
8. **Recommended Meta Structure** — the account structure you recommend, built only from what this account's numbers show. First a table, one row per campaign to run, every cell 1–5 words:

   | Layer | Campaign | Audience | Budget share | Creative focus |

   Layer is Prospecting, Retargeting or Retention (or Testing). Budget share is a % of the current spend, adding up to 100%. Then at most three bullets: which current campaigns become which row (merge, keep, pause), the exclusions between layers, and the one thing that decides whether the structure is working (the metric and its target). Keep what already works; change only what the evidence argues for.
9. **Prioritised Recommendations** — one card per action, each opened by a ### numbered heading, not a table:

   ### 1. <the action, under 12 words> (fixes R1)
   - **Expected impact:** …
   - **Effort:** Low / Medium / High · **When:** Week 1 / Weeks 2–3 / Month 2+

   Order by phase: tracking and quick fixes in Week 1, tests that need setup (one A/B test at a time, ~2 weeks each) in Weeks 2–3, scaling and bidding changes in Month 2+. For a test, state the one thing it changes and the metric that decides it. Only recommend a test the evidence supports (an option from "not used in the audited period" or a clear gap in a table). At most eight cards.

   Actions only: don't restate the evidence from Risks, and don't list two actions for the same fix.
10. **Next Steps** — one sentence: the single highest-impact action; recommendations only, no changes made.

The detailed "Audit checklist" is appended automatically after your report in the chat — don't reproduce it. It is not part of the downloaded report, so never point the reader to it ("see the checklist"); a failed checkpoint that matters is a risk card.

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
