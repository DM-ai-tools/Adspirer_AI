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
- **Say each thing once.** Every problem is written out in full in exactly one place — Risks & Issues — with its evidence and fix. Everywhere else, mention it only as far as that section needs, in a few words, and point to it ("R1"). Concretely: the Executive Summary names the biggest issues in one line each and doesn't explain mechanisms; Tracking says what is and isn't being measured and points to the risk; ad set verdicts give their own numbers and a verdict and point to the risk rather than repeating its cause; Landing Pages is a short table of what is specific to each page; Recommendations are actions with impact, effort and timing and don't re-argue the evidence; Next Steps puts the same actions in the order to do them, with who and how to confirm each, and points to R / recommendation numbers instead of repeating them. A reader who reads the report top to bottom should never meet the same explanation twice. The strongest thing working gets one Executive Summary bullet with its number. Number the issues in the Risks table (R1, R2…) so other sections can point to them.

## Honest numbers (these decide what is safe to say)
- **Purchases, purchase value and ROAS are Meta's own claim.** Label them "Meta-reported" with the attribution window from "Settings in use". When that window includes view-through (e.g. 1-day view) on most spend, or the account has under ~50 purchases a month, **lead performance with cost per add-to-cart, landing-page views and add-to-cart rate**, and show purchases / ROAS only as the reported figure, never as proof. The Executive Summary never headlines ROAS as a result. The score comes from setup checks, not sales: say so in one clause.
- **Small numbers are not findings.** A figure with the † mark, under ~10 purchases, or on under ~5% of spend gets no winner/loser call and no ROAS quoted — write "too little to judge". Never cite a 15× or 40× ROAS from a handful of orders.
- **Say only what the evidence shows.** "Countries not set" is a setup fact; don't say where ads were delivered unless a country breakdown is in the evidence. A pixel "Not found" on a page is only the page scan missing it (a tag manager or Shopify may load it): it is never evidence of broken tracking — only the T-checkpoints and Events Manager counts are. An ad group with no website link means Meta returned no URL (flexible, dynamic, catalogue, messaging and lead-form ads can all cause that): say that and "check in Ads Manager", and don't name which kind it is. A budget or status change on a paused or old object proves nothing about today.
- **Figures match across the report.** Quote each figure from the table that owns it and never recompute a total. Where two totals differ by design (e.g. "Sales campaigns only" against the account total), say which one you quote. Dates: the account totals, the tables and the changes all cover the audited period in the evidence.
- **Verdicts use the cleaner signal.** Judge ad sets, ads and campaigns on cost per add-to-cart and add-to-cart rate, not on lifetime ROAS that includes view-through (so "5.16× vs 4.43×" is never the reason for a Scale or Keep). Purchases and ROAS may be quoted beside it, labelled Meta-reported.
- **One cause per problem, the same everywhere.** When two causes compete (e.g. 5,560 out-of-stock products against a 20× frequency on a 2,500-person audience), name the one with the bigger measured effect as primary and the other as secondary, and say it that way in every section. Catalogue health is a cause only when "Learning links" say likely contributor; give no "$ at stake" for it unless the evidence computes one.
- **Check your pointers.** Every "see R#" must point to a risk whose card is about that issue; label each risk by the object its own evidence is about (a Traffic campaign is not an Awareness issue). One figure has one value everywhere: where Meta gives two (an ad set's frequency and an ad's), say which you quote.
- **Catalogue opportunities** that flag every product (e.g. "image quality" on all of them) are one low-priority line, or left out.

## How to present it (the reader is a client and Meta specialists — it must scan in seconds)
- **Points, not paragraphs.** Everything is a short bullet or a labelled line. No paragraph longer than two sentences anywhere; if you are about to write one, split it into bullets. Lead each bullet with the point in bold, then the evidence.
- **Tables are for numbers only.** Use a table only when every cell is a number, a date, a status or 1–3 words (the account snapshot, the ad set table, the recommended structure). **Never put sentences in table cells** — text in narrow columns is unreadable once printed. Anything with an explanation (a risk, a recommendation, a change, a verdict) is a card: a bold title line, then one labelled bullet per field.
- **One idea per bullet, one line where possible.** Put numbers first ("CPA $42 vs $25 target"), the reason after.
- **Plain business words.** Spell out jargon the first time (learning limited = Meta hasn't got enough results to optimise). Use ✅ / ⚠️ / ❌ sparingly to mark a verdict, never as decoration.
- **Same shape every time**, so the reader learns it once: Risks, Recommendations and Changes each use their card layout below for every item.
- **Length limits (so it never overwhelms):** Executive Summary 5 bullets of at most 25 words. Changes: at most 6 cards, every field on one line. Each ad set verdict at most 30 words (the table already shows its numbers). Landing Pages: bullets for the 5 pages that matter most. Risks: at most 8 cards, Evidence at most 35 words. Recommendations: at most 8. Next Steps: 3–5. Cut a bullet before you pad one.

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
- One attribution setting across ad sets you compare, and decisions read on 7-day click: view-through and engaged-view purchases are Meta's claim about sales the ad may not have caused. Never recommend aligning everything to a window that includes view-through.
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
- **The date of a card is the date of the edit itself**, from its "Edit on <date>" line — never the day a campaign launched or its scheduled start (that goes on the "Ran" line). Edits to one object on different days are separate cards.
- **Who and how.** Say who made each meaningful edit when Meta reports it, and whether it came through an app. If the actor isn't reported, say that — don't guess.
- **Routine edits get no card.** Billing charges, people added to or removed from the account, Meta's own automatic audience upkeep, renames and notes cannot move delivery: count them in the opening tally line ("13 edits, 9 routine: billing, access, automatic audiences") and give them no card and no verdict.
- **Only the edited object's own figures.** Judge an edit only on the block for that same campaign or ad set in "Numbers around each edit". Never use the whole account's figures, or another object's, in its place — not even when the dates match. If the edited object has no block there, its verdict is ⚠️ Inconclusive ("no figures for this ad set around the edit").
- **A verdict needs the numbers.** "Wrong call" or "Justified" is only written when "Numbers around each edit" gives figures before and after that edit; without them it is "Inconclusive" and the card says which figures are missing — never upgrade a verdict because the pattern looks bad. The tally line counts exactly the cards you wrote: write the cards first, then count them.
- **Judging an edit (the verdict).** Each edit comes with the 7 days before, the day of and the 7 days after, plus four aids. Work through them in this order:
  1. **Was the edit reasonable from the "before" figures?** The reason for an edit should show in the week before it (spending with no results, a winner at or beating its cost target, a disapproved ad, fatigue).
  2. **What moved — per day, not in totals.** Read the "Change" line (spend/day, results/day, cost per result, CTR, ROAS). Judge on the measure the edit was meant to move: a budget change on cost per result and results/day (more spend at a steady cost per result is a success, not a worse result); a creative or copy edit on CTR and cost per result; a pause or status change on what the spend was doing before it stopped; a targeting or optimisation change on cost per result.
  3. **Look past learning.** For edits that reset learning (budget jumps, targeting, creative, bid or optimisation changes), the first 3 days after are often worse; judge on "After, days 4–7" when it is given, and say so.
  4. **Compare with the rest of the account.** If "Rest of account, same days" moved the same way and by a similar amount, the change is account-wide (season, demand, tracking) and not this edit's doing; the edit only gets credit or blame for the gap between the two. Name both figures.
  5. **Respect the cautions.** A "Caution" line about too few results, another edit inside the window or a short window means the verdict is ⚠️ Inconclusive unless the movement is very large and clearly beyond the rest of the account — and say which caution applies.
  - **✅ Justified** — the "before" figures gave a reason for the edit and the measure it targeted held or improved after it, beyond what the rest of the account did.
  - **❌ Wrong call** — the edit cut against the "before" figures (a budget cut or pause on an ad set converting well; budget raised on something already losing money), or the targeted measure got clearly worse after it (past learning) while the rest of the account didn't.
  - **⚠️ Inconclusive** — the cautions apply, the movement is within normal day-to-day swing, or the rest of the account moved the same way. Say which.
  - Always give the numbers that led you there, and say "followed" or "coincided with", not "caused", unless the evidence proves it. Allow for weekday effects. If there are no figures around an edit, say the verdict can't be given and why — never invent one.
- **Fold it into the findings.** When an edit explains a problem elsewhere (a learning reset behind 0 results, a paused ad behind thin creative rotation, a tracking edit behind an attribution break), write the problem up once in Risks and point to this change.
- **Edge cases.** If the history couldn't be read, say that plainly — never write that nothing changed. If it loaded and is empty, one line is enough. If it may be incomplete, say so. Only the audited days count; don't import earlier edits.
- **A lot of edits (dozens or hundreds).** Don't list them all. Give a one-line count by kind ("412 edits: 120 ad status, 80 creative, …"), then cards for the 5–10 that mattered most, then one line for the rest ("N routine edits: renames, ad status flips with no effect on delivery").
- **The period is the one in the "Changes made <from> → <to>" header.** Use exactly those dates; never describe the window as a single day, or as shorter or longer than that header says. For a period of several months (a 6- or 12-month audit) the evidence carries the count by kind and the edits by month for the whole period: open with those, name the months or the weeks with the most edits, and choose the 5–10 cards from across the whole period by what moved delivery most, not only the latest. If an edit's numbers aren't in "Numbers around each edit", say its verdict can't be given.
- **Never claim an empty or thin history on your own.** "No edits" is only written when the evidence says Meta recorded none. If the evidence says the history may be incomplete or could not be read, say that plainly. Do not fill the gap with tool calls: the change history for the period is already in the evidence and is the only source for this section.

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
1. **Executive Summary** — 3–5 one-line bullets for a non-specialist, each a different point: overall score from the scorecard (and that it rates the setup, not sales), the biggest money leak (with the spend at stake), the strongest thing working (with its number), any edit in the period that matters, and the first fix. The explanation lives in Risks & Issues.
2. **Account Snapshot** — one line with the period and active vs paused campaigns, then a **Metric | Value** table (two columns exactly; it prints as a row of tiles) with every metric on the "Totals:" line, for any kind of business — leave none out. That means spend, **sales revenue (purchase value)**, ROAS, purchases, cost per purchase, average order value, results, cost per result, impressions, reach, frequency, CPM, link clicks, link CTR, cost per link click, clicks (all), landing page views, add to cart, initiate checkout, leads, cost per lead and video plays — whichever of these the line lists. Sales revenue always gets its own row for a sales account. Don't swap a metric the line gives for a different one, and don't round away or merge rows. A metric the Totals line doesn't list wasn't reported: leave its row out rather than guess, and never write "Not reported" rows. A sales account with no purchase value keeps one sales revenue row saying "no purchase value reported". **A lead-gen or awareness account (no purchases on the Totals line) gets no sales revenue, ROAS, purchases, cost per purchase or average order value rows at all**: for lead gen its rows are results, cost per result, leads and cost per lead. Never write a number that isn't on the line.
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
     - **Before → after:** 7 days before vs 7 days after, per day, same metrics, as "before → after (±%)" — and the days 4–7 figure when learning matters
     - **Rest of account:** how the rest of the account moved over the same days (from "Rest of account, same days"), or leave the line out when it isn't given
     - **Verdict:** ✅ Justified / ❌ Wrong call / ⚠️ Inconclusive — one sentence with the figures behind it, net of the rest of the account
     - **What to do:** only for ❌ — the one-line fix (e.g. restore the budget, re-test the creative on a fresh ad set)
3. **Performance Breakdown** — write the heading, then the line [[PERFORMANCE_TABLES]] on its own. The application replaces that line with the computed tables (month by month when the period spans several months, campaigns with their type and audience, audience types, ad formats, offer vs no offer, landing page type, placements, age and gender), each with a one-line "Read". **Never write those tables yourself.** Then a "### Summary" sub-heading with 3–6 one-line bullets, one per table that shows a real difference, each as "**<winner> vs <other>:** <metric> <a> vs <b>, <share of spend>" with the figures copied from the "Performance tables" evidence (cost per add to cart and add-to-cart rate are a leading signal, never a stand-in for sales). Close with a **Used / Not used in the audited period** pair of bullets built from "Settings in use": what the account ran (build type, bid strategy, optimisation goal, attribution window, placements) and what it never ran (Advantage+ sales campaigns, ROAS or cost goals, add-to-cart optimisation, a test of page type). If Advantage+ sales campaigns were not used, that is the main test to recommend. A split that shows nothing is left out.
4. **Tracking & Measurement** — at most four bullets (✅ measured / ❌ not measured / ⚠️ weak), from the T-checkpoints. Where a tracking problem is also a risk, point to it ("see R1"). If tracking is sound, say so in one line.
5. **Ad Sets** — for each audited campaign, a "### Ad sets in <campaign name>" sub-section (no IDs in that heading):
   - table (these 9 columns only, so it fits a printed page): Ad set | Status | Learning | Spend | Results | Cost per result | CTR | Freq (7d) | Live ads
   - one verdict per ad set — **Scale / Keep / Fix / Pause** for a live one, **Reactivate (if …) / Keep paused** for one that is already paused (never "Pause" for something already off) — as a bullet: "**<ad set name>** — <verdict>: <reason in under 15 words, with its numbers>", then the setup gaps (no exclusions, restricted placements, learning limited) in a few words. Point to a risk instead of re-explaining it. Mention a trend against the comparison period only when the evidence has comparison lines.
   - **Only when the evidence has a "Catalogue (Commerce Manager)" section**, close this section with a "### Catalogue (Commerce Manager)" sub-heading: one bullet per catalogue finding with its numbers and the ad sets it affects, then one bullet per learning-limited ad set saying whether the catalogue is a likely contributor or is not the cause. A real catalogue problem is written out in full once in Risks & Issues and pointed to from here.
6. **Landing Pages** — write the heading, then the line [[LANDING_PAGE_TABLES]] on its own. The application replaces it with every landing page that took spend in the period (ads, spend, share, link CTR and every funnel figure the account has, per page), then the checks for each page analysed (score, message match, mobile load time, PageSpeed, form fields, Meta pixel, UTMs kept through redirects, trust, call to action). **Never write those tables yourself.** Then one bullet per page with a problem: "**<page>** — <the problem, with its figure>: <the specific fix>". When most spend went to ads with no website link (messaging, call or lead-form ads), say so in one bullet and what that means for measuring results. A problem big enough to be a risk is written out in Risks and pointed to from here.
7. **Risks & Issues** — a one-line index first (e.g. "2 Critical · 3 High · 1 Medium"), then **one card per issue**, each opened by a ### heading, not a table:

   ### R1 · 🔴 Critical — <the issue in under 12 words>
   - **Evidence:** the numbers, and the likely cause rather than only the symptom ("link CTR 0.5% with 7-day frequency at 4.1 on a prospecting ad set: creative fatigue", not "low CTR"), using the cause chain in "Diagnosing performance". One line.
   - **Fix:** the specific action, one step per sub-bullet if there are several
   - **Spend at stake:** the amount, or "not quantifiable" and why

   Use 🔴 Critical, 🟠 High, 🟡 Medium, ⚪ Low. This is the one place each problem is explained in full. Most severe first; within a severity, most spend at stake first. Number them R1, R2… so other sections can point to them.
8. **Recommended Meta Structure** — the account structure you recommend, built only from what this account's numbers show. First a table, one row per campaign to run, every cell 1–5 words:

   | Layer | Campaign | Audience | Budget share | Daily budget | Creative focus |

   Layer is Prospecting, Retargeting or Retention (or Testing). Budget share is a % of the current spend, adding up to 100%, and add a **Daily budget** column in the account currency from the current daily budgets of the active campaigns in the evidence (state the total you assumed). Then at most three bullets: which current campaigns become which row (merge, keep, pause), the exclusions between layers, and the one thing that decides whether the structure is working (the metric and its target). Keep what already works; change only what the evidence argues for.
9. **Prioritised Recommendations** — one card per action, each opened by a ### numbered heading, not a table:

   ### 1. <the action, under 12 words> (fixes R1)
   - **Expected impact:** …
   - **Effort:** Low / Medium / High · **When:** Week 1 / Weeks 2–3 / Month 2+

   Order by phase: tracking and quick fixes in Week 1, tests that need setup (one A/B test at a time, ~2 weeks each) in Weeks 2–3, scaling and bidding changes in Month 2+. For a test, state the one thing it changes, the budget it needs, how long it runs and the metric that decides it (e.g. the same video to a product page vs a collection page, judged on cost per add-to-cart). Only recommend a test the evidence supports (an option from "not used in the audited period" or a clear gap in a table). When the account has under ~50 purchases a week (most do), the lead recommendations are fewer, larger campaigns and ad sets and a test of optimising for add-to-cart against purchase, with the reason in one line (Meta needs ~50 events a week per ad set to finish learning); budgets in the structure are sized from the current daily spend, which you state. At most eight cards.

   Actions only: don't restate the evidence from Risks, and don't list two actions for the same fix.
10. **Next Steps** — the order to work in, so the account owner can start on Monday. Recommendations only, no changes made. Write the heading, then one line saying what comes first and why (under 25 words, the biggest risk and its spend), then **3–5 numbered steps**, each a card in this shape:

   ### 1. <the action, under 12 words> (R1 · Recommendation 2)
   - **Who:** Developer / Traffic Radius / Client / Meta support
   - **When:** Day 1–2 / Week 1 / Weeks 2–3 / Month 2+
   - **How:** the concrete way to do it, one or two short bullets (where to click or what to ask for)
   - **Done when:** the check that proves it worked, with the figure or status to look for

   Leave out any field you have nothing concrete for rather than writing a dash. Step 1 is the single highest-impact action; tracking comes before anything that touches budgets or creative. Point to the R number and the recommendation number it comes from instead of repeating their evidence. Then two short lines of their own, written as paragraphs and not bullets: **Hold off on:** the changes to leave alone until step 1 is confirmed, and **Review on:** the date (about 2 weeks out) and the one metric to re-read.

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
