# Campaign settings card — design

## Intent

Agency operators create Meta campaigns through the workspace chat. The Meta specialist on the team named the settings that matter most when a campaign is set up. Today several are fixed in code (performance goal is derived from the objective), one is missing (device and OS targeting), and none are chosen from dropdowns. The operator should pick them in one place, quickly, with Meta-valid options only, a short explanation of each, and sensible AI-suggested defaults.

Success: an operator briefs a campaign in chat, adjusts one card, and the approval that gets queued carries exactly those settings and is accepted by Meta. No trip to Ads Manager to fix settings afterwards.

## The settings (confirmed by the Meta specialist)

1. Budget level: campaign budget (CBO) or ad set budget.
2. Conversion location (destination): website, instant forms, messaging, calls, app.
3. Performance goal (optimization goal).
4. Conversion event.
5. Attribution setting.
6. Age range.
7. Advanced placements: platforms, placements (positions), device, OS.

## Behaviour

- One "Campaign settings" card in the chat, shown after the objective is known and before creative. All settings on one card, not a question per setting (operator's request: easy and quick).
- Every field is a dropdown or multi-select with a one-line description under its label.
- The AI pre-selects each applicable field from what the operator has said (objective, goal, business, whether a pixel or lead form exists) and shows a short reason beside the pick. The operator can change any of them. Nothing is applied that the operator did not see on the card.
- Options depend on earlier choices. Only combinations Meta accepts are offered: objective → conversion location → performance goal → conversion event. Attribution options depend on the performance goal. Changing an upstream field resets and re-suggests the dependent ones.
- Confirming the card puts a structured settings block in the composer, like the existing targeting picker, and the model passes those fields to the create tool. The queued approval displays them.
- Server-side validation is authoritative: an invalid combination is rejected with a plain message; it is never silently altered.

## Where options come from

- Fetched live from Meta for the client's mapped ad account: pixels and their events, Pages, lead forms, device list, OS versions (Meta targeting search by class), custom audiences are already available.
- Not available from the Meta API: which performance goals and attribution windows are valid for each objective and conversion location. These are Meta's published rules and are held as one table in the codebase (`lib/meta/campaign-rules.ts`), tied to the Graph API version in config. Placement names are Meta's fixed enums.

## Changes by area

- Rules table and validator (new).
- Options endpoint under `/api/v2/meta/` returning live options for an account and objective (new).
- Chat: new `campaign_settings` UI payload, card component, and a compose function like `composeTargetingMessage`; the system prompt tells the model when to show it and how to fill suggestions.
- Create tools: accept and validate `optimization_goal`, `destination_type`, `device_platforms`, `user_device`, `user_os` in addition to the existing attribution, budget-level, age and placement fields; `targeting-builder` maps them onto the ad set and promoted object; the approval card shows them.

## Goals

- One card, a few clicks, correct by construction.
- Descriptions short enough to read at a glance.
- Defaults the operator can trust and override.

## Non-goals

- Bid strategy, schedule, creative, audiences and locations (existing flows stay as they are).
- Dynamic creative, A/B tests, catalog and app campaigns beyond what the rules table covers for the listed objectives.
- Any Google or non-Meta platform.

## Anti-goals (failure even if it technically works)

- A suggestion applied without the operator seeing it.
- An option shown that Meta then rejects at approval time.
- The card slowing the flow: it must load with options from one request and not block on the model.

## Constraints

- Changes still only reach Meta through Approvals; campaigns are created paused.
- Existing campaign-creation behaviour for operators who do not touch the card must not regress.
- The existing create schemas and approval matching keep working for approvals already queued.

## Decided by the operator

- One card with everything pre-filled and adjustable, not a step-by-step Q&A.
- Dropdowns fed from Meta where Meta provides the data.
- Short description on each setting; AI suggests where applicable.
- First version supports only website and instant forms as conversion locations. Messaging, calls and app are shown greyed out as "not supported yet". Messaging and calls (which need WhatsApp or phone setup) are a later version.

## My calls (not yet confirmed)

- The card appears after the objective is known, not at the very start.
- The rules table is hand-maintained; a unit test pins its combinations so a Graph version bump is a deliberate change.
- Device and OS are optional and collapsed under "Advanced placements" by default.
- Scope: the five objectives the app already supports (Sales, Leads, Traffic, Engagement, Awareness) and the create tools that exist today (image and video campaign, ad set, ad). Carousel, catalog and dynamic-creative tools do not exist in this app and are out of scope.
- The card only offers what the create tools can execute. A setting a tool cannot take is shown disabled with a one-line reason, never offered and then ignored.
- Defaults and their reasons are computed on the server from the objective and what the account has (pixel, Page, lead form) with plain rules, returned with the options in one request. The model does not generate them, so the card never waits on it. The model only passes along what the operator already said (objective, goal) so those are pre-selected.
- When live options are missing: the field degrades with an inline message ("No pixel found on this account"), and the existing creation errors still apply (for example Sales needs a pixel). A failed Meta lookup, an unmapped account or an expired token shows one banner on the card and leaves the rest usable.
- When the operator ignores the card or no settings block is sent, today's behaviour stays: the performance goal is derived from the objective as it is now. The new fields are optional and a test pins the old result.
- The card owns age range and placements. The targeting picker keeps locations, audiences, interests and behaviours. If both supply age or placements, the most recent one wins and the approval shows the final values.
- Device and OS come from Meta's targeting search; if that lookup fails or returns nothing usable, a short curated list is offered instead.

## Left to the builder

- Exact Meta enum names and valid combinations for the supported objectives, to be checked against the Graph API version in `META_GRAPH_VERSION`.
- Card layout and component structure, following the existing `targeting-picker`.
- Caching of option lookups.
