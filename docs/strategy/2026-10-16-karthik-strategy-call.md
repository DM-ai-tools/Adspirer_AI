# Strategy call with Karthik — summary & actions

Oct 16, 2026 · @Rithin LS Dotmappers

## Overview

Karthik wants Adspirer to move from grading what's already running to planning everything needed to hit a goal. That means a target ROAS, full business context, and one shared framework across every Dotmappers tool.

- **Attendees:** Karthik Bala, Subhashini S, Rithin LS
- **Length:** 32 minutes, 16 October 2026
- **Note:** parts of the transcript are garbled. Points marked *(unclear)* are best interpretations.

## What's wrong with the current audit

The audit only grades what the team already does, so it can't see the much bigger set of things nobody has tried.

- It reads past Meta data only. It scores current campaigns as good or bad against a benchmark and against past ROAS.
- **Blood-test analogy:** an audit is like a blood test. It reports good or bad on the tests you ran, but says nothing about the 97 tests you never ran.
- If 10 things are needed to hit a target and the team does 3, the audit grades those 3 and never flags the missing 7.
- **DuringDays example:** about 500 categories on the site, but only a few get ads. Spend is $1,200/day; Karthik thinks it should be about $30,000/day.
- Meta only "knows" the categories that have been advertised ("five bedrooms, only two used"). The tool doesn't read the website, so it has no idea what's missing.

## Goal-driven strategy

The tool should take a budget and a target ROAS, then lay out the full plan to reach it, not just grade the current setup.

- **Inputs:** budget and target ROAS (for example 10x).
- **Output:** every Meta campaign type, objective and feature that would help hit the target. This is work that isn't humanly possible to do by hand.
- **Horizontal:** all the campaign approaches. **Vertical:** apply them across every category (for example 100 categories, each aiming at 10x).
- **Stretch targets:** push to 12x, 13x or 15x and get a revised plan.
- **Reality check:** compare the target with competitor benchmarks, the same process the team uses for SEO and Google Ads.
- **Website check:** the site must be able to handle that level of traffic and sales.
- **Margin-based ROAS:** high-margin categories can run a lower target ROAS and be more aggressive. Not one flat 10x for everything.
- **What the plan covers:** campaign structure and a creative plan. If the strategy is approved, the tool should execute it.

## The three-level model

Karthik wants the output in three levels, each adding more context about the business, ending in a tailored plan.

[embedded content: three-level model · audit to tailored plan]

In his analogy, Level 3 is like adding age, weight and habits to a blood test, then getting a lifestyle plan to follow and track.

## Context and memory

Without knowing the full business (for example all 500 categories), the tool can't build a real plan. It needs stored context it checks on every run, the same way it already checks competitors.

| Source type | What to add | How |
| --- | --- | --- |
| Internal | Category and product-line list | Excel upload |
| Internal | Sales, inventory, SKU and supplier data, product feed | Upload or connection |
| External | Competitor data | Connection |
| External | Benchmark data, including which site the 10x benchmark is based on | Connection |
| External | Amazon best-seller and category data | MCP |

- **The loop:** retrieve the data, add it to the context, then re-run at scale against the goal.
- **Purpose of the data:** mainly for the tool to re-optimise as it goes. Showing it on screen is only to check it's heading in the right direction.
- He also mentioned guardrails, a "harness" and closing the loop *(unclear)*.
- Rithin noted that document upload already exists, but storing a large e-commerce context in the system still needs checking.

## One framework across all tools

The core principles should be written down once and built into every tool: Creative Studio, SEO, Google Ads, Adspirer (Facebook) and Marketing in a Box.

- Other tools on the market only offer tactics (skills). Karthik wants two layers on top, framework and strategy, as the point of difference.
- Most tools leave the framework to a subject-matter expert to fill from their own know-how. Ours should build it in.

## Live test: the bar stool question

The tool couldn't answer Karthik's test question, because it has no category-level data and only a Meta connection.

- **The question:** a container of bar stools costs $20k and needs $40k in sales. How do you spend $4k and get $40k back (10x) using Google Ads and Meta together? He first said $40k cost, $80k sales and $40k marketing, then reworked it to these numbers.
- **The follow-up:** how much has gone into bar stools so far, what did it return, and what was the best category in the last 30 days?
- **Why it failed:** no campaign, ad set or ad is named by category. The tool would have to match every ad and creative to bar stools, which is slow.
- **His suggestion:** use landing-page clicks, UTMs and clickstream data to find top clicked and top selling products.
- **Source of truth:** GA4 is what all platforms should reconcile against. The tool suggested Shopify Analytics or GA; Karthik seemed to say Shopify alone isn't good enough *(unclear)*.
- **Next step he described:** ask what has to change to hit the target, get a new structure, then test it on one category with a set budget.

## Other items and expectations

Karthik expects Rithin to check that the framework is actually built into each tool before bringing others into these meetings.

- **Rithin's role:** he's the one person in most of these meetings. He should know whether the principles are deployed, working, or missing in each tool. Karthik said "most places not added" is the fundamental problem.
- **Subhashini's view:** the points are already built in, but the criteria Karthik described still need to be adopted.
- **Google Ads connection:** Subhashini said it isn't connecting, for what sounded like Shreya and DuringDays *(unclear)*. Check with Ashraf.
- **Default connections:** every tool should connect GA4 and Google Search Console as standard.

## Changes to implement

Twenty changes, grouped by area. Start with the follow-ups at the bottom, since Karthik is waiting on them.

**Adspirer: strategy features**

- [ ] Add goal inputs (budget and target ROAS) and generate a full strategy from them, not just pass/fail findings
- [ ] Add a gap view: everything the account could be doing (campaign types, objectives, features, untouched categories) against what it does now
- [ ] Plan in both directions: across campaign approaches and across categories
- [ ] Support stretch targets (12x, 15x) and re-plan when the target changes
- [ ] Accept gross margin per category and set a different target ROAS for each
- [ ] Include campaign structure and a creative plan in the strategy, with execute-on-approval
- [ ] Restructure output into three levels: baseline audit, industry benchmark, then tailored plan with tracking
- [ ] Show the external route (competitors) and internal route (own assets) side by side
- [ ] Check every target against competitor benchmarks, and show which reference it uses

**Context and data**

- [ ] Build persistent context used on every run: category lists, sales, inventory, SKU, supplier data, product feed
- [ ] Add external sources: competitor data, benchmark data, Amazon best-seller data via MCP
- [ ] Build the retrieval loop (retrieve, add to context, re-run) with guardrails; the tool uses data to re-optimise
- [ ] Connect GA4 and Google Search Console as defaults across every tool, with GA4 as source of truth
- [ ] Enable category-level reporting from landing-page clicks, UTMs and clickstream data
- [ ] Fix the Google Ads connection with Subhashini and Ashraf

**Framework and process**

- [ ] Write the shared framework and strategy principles as a standalone document
- [ ] Audit each tool (Creative Studio, SEO, Google Ads, Adspirer, Marketing in a Box) for whether the framework is built in, working or missing, before every meeting

**Follow-ups Rithin committed to**

- [ ] Feed this discussion into the tool, get the three-level strategy, refine it and share with Karthik
- [ ] Answer the bar stool $4k to $40k question and the bar stool spend-and-return question once data is connected
- [ ] Pick one category, set a test budget, run the new structure and check whether it works
