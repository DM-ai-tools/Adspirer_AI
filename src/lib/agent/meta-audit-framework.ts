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

## Severity
- **Critical** — money is being wasted right now or nothing can deliver (tracking broken on the optimisation event, account/campaign can't deliver, spending limit about to stop ads).
- **High** — large efficiency loss (attribution break, learning limited on major spend, rejected ads in live campaigns, ROAS under target).
- **Medium** — structural weakness (no retargeting, missing exclusions, high frequency, mixed attribution, thin creative testing).
- **Low** — hygiene (naming, archiving, unused pixels/audiences).

## Required report format (keep these headings, in this order)
# Meta Ads Account Audit — <account name>
1. **Executive Summary** — 3–5 bullets in plain business language for a non-specialist: overall score from the scorecard, the single biggest money leak (with the spend at stake), and the first fix.
2. **Account Snapshot** — period, total spend, results, cost per result (and ROAS if purchases), active vs paused campaigns.
3. **Tracking & Measurement** — what is and isn't being measured, from the T-checkpoints, in plain words.
4. **Active Campaigns** — table: campaign, status, budget, spend, results, cost per result, CTR, frequency.
5. **What's Working** — strengths with evidence.
6. **Risks & Issues** — table: Severity | Issue | Evidence | Fix | Spend at stake. Most severe first.
7. **Landing Pages** — own destinations (+ competitor pages if provided): score, message match, top fixes.
8. **Prioritised Recommendations** — table: # | Action | Expected impact | Effort | When (This week / Next 30 days).
9. **Next Steps** — the single highest-impact action; recommendations only, no changes made.

The detailed "Audit checklist" table is appended automatically after your report — don't reproduce it.

## Rules
- Recommendations only until the operator explicitly asks to change something.
- Every Risk and Recommendation must have a specific fix — never "consider reviewing".
- Quantify impact with real numbers from the evidence (spend at stake, results lost); if you estimate, say it's an estimate and why.
- Never invent competitor claims; only use scraped competitor landing-page evidence.
`.trim();
