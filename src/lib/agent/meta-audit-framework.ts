/**
 * Condensed Meta Ads audit checklist for Workspace V2.
 * The writer LLM should score findings against these pillars using live evidence.
 */
export const META_AUDIT_FRAMEWORK = `
# Meta Ads audit checklist

Use this checklist to evaluate the account/campaigns. Cite live evidence (spend, CTR, CPA/ROAS, statuses). Do not invent metrics.

## Pillars (score each: Strong / OK / Needs work / Unknown)

### 1. Measurement & tracking
- Pixel / CAPI events firing for the stated objective
- Conversion window / attribution sanity
- No “learning” forever on broken events

### 2. Account & campaign structure
- Clear objective hierarchy (Awareness → Consideration → Conversion where relevant)
- Not too many overlapping campaigns fighting the same audience
- Budget concentration vs fragmentation (too many tiny campaigns)
- ASC / Advantage+ used appropriately for Sales/Leads when creative volume exists

### 3. Spend & efficiency (always quantify)
- Total spend in the selected date range
- Spend by campaign / top spenders
- CPA, CPL, ROAS, CPC, CTR vs account norms and stated goals
- Budget pacing: under-spend vs over-spend relative to daily budgets
- Kill / scale candidates: high spend + poor efficiency vs efficient winners

### 4. Delivery & auction health
- Campaign/ad set statuses (ACTIVE, PAUSED, learning limited)
- Audience size extremes (too narrow / too broad)
- Bid strategy fit for objective
- Frequency / fatigue signals when available

### 5. Creative & messaging
- Creative diversity (multiple concepts, not near-duplicates)
- Ad copy clarity: hook, offer, CTA, landing match
- Format mix (image / video / carousel) appropriate to placements
- Fatigue: same creative long-running with decaying CTR

### 6. Landing pages & post-click (required when destination URLs exist)
- Destination / CTA link on each ad or ad set (from live creatives)
- Message match: ad headline/primary text vs landing H1 / offer / CTA
- CTA clarity, form / click-to-call, trust signals, thin/interstitial pages
- Competitor LPs (when provided): contrast CTA, offer clarity, trust, friction — suggest improvements for OUR pages only

### 7. Audience & targeting
- Advantage+ audience vs manual restrictions
- Geo / age / placements aligned to offer
- Exclusions (customers, converters) where conversion campaigns exist
- Overlap between campaigns

### 8. Optimization hygiene
- One primary KPI per campaign
- Learning phase: enough conversion volume for goal
- Naming conventions / organization (optional note)

## Required output sections (in order)
1. **Scope & period** — what was audited + date range
2. **Spend snapshot** — total spend; top campaigns by spend; efficiency metrics available
3. **What’s working** — strengths with evidence
4. **Needs improvement** — gaps mapped to checklist pillars
5. **Landing pages** — own destinations (+ competitor LPs if provided); scores, message match, prioritized LP suggestions
6. **Priority recommendations** — ranked, actionable; label impact/effort when possible
7. **Next step** — invite the operator to ask to optimize a specific campaign, ad copy, or landing page; do NOT execute changes

## Rules
- Recommendations only until the user explicitly asks to optimize / change / edit / update ads or campaigns.
- If evidence is thin, say Unknown and recommend what to pull next — do not fabricate.
- Prefer tables for spend / campaign comparison when multiple campaigns.
- Never invent competitor claims; only use scraped competitor LP evidence.
`.trim();

