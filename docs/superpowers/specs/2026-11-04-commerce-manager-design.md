# Commerce Manager: catalogue insights, a Commerce page and catalogue fixes

Date: 2026-11-04 · Status: approved 2026-11-04

## Intent

Ecommerce clients run Meta catalogue (product) ads. When those ads underperform, and in
particular when ad sets sit in **learning limited**, the cause is often in Commerce Manager,
not in the campaign: products rejected or out of stock, a stale or failing feed, a product
set that is too small, or the pixel not matching purchases to catalogue items. Today the app
reads none of this; it only knows spend per product id (the `product_id` insights breakdown).

The operator (Rithin) is not a Commerce Manager expert and wants the app to be the expert:
read everything relevant, explain it with evidence, suggest optimisations, and let him fix
what can be fixed from the app.

## Goals

1. **The workspace chat and the Meta audit can read Commerce Manager freely** (read-only Graph
   calls) and use it as evidence, especially to explain learning-limited ad sets.
2. **A Commerce page in the side panel**: pick the client and a catalogue and see everything
   relevant: health, products, feeds, product sets, which ad sets use them, pixel matching.
3. **Suggested optimisations** with the evidence behind each one.
4. **Fixes from the app**, every one queued through the existing approval system. Nothing
   changes on Meta until the operator approves.

## Non-goals (v1)

- Creating catalogues or feeds from scratch, or onboarding a new store into Commerce Manager.
- Meta Shops / checkout settings, commerce orders, Instagram Shopping tags.
- Editing product data (title, price, image) that comes from a synced source such as
  Shopify; it would be overwritten by the next sync. The app tells the operator what to
  change and where instead.
- A scheduled background sync into new database tables (live reads with a short cache).

## Anti-goals (a failure even if it technically works)

- A catalogue finding stated without numbers from the live catalogue behind it.
- Blaming the catalogue for learning limited when the catalogue is healthy: the audit must
  say "catalogue is not the cause" when that is what the data says.
- Any write to Meta that skips the approval queue.
- A page that silently shows nothing when the token lacks `catalog_management`; it must say
  what is missing and offer the reconnect.

## Constraints

- **Permission.** `catalog_management` is now requested on the Facebook connect button
  (shipped 2026-11-04, commit 907e624). The Meta app has the Catalog API use case at Standard
  access ("Ready for testing"), so it works for people with a role on the Meta app. Client
  staff outside the app need business verification + App Review (tracked separately). Every
  catalogue read must check for the scope and degrade with a clear message.
- **Token model.** The token is the operator's (`getUserMetaToken`), not the client's. The
  app sees the catalogues that person can see, in any business portfolio.
- **Scope to the client.** A client only sees catalogues linked to its mapped ad accounts
  (see "Finding a client's catalogues"), never every catalogue the operator can reach.
- Next.js 16 conventions in this repo (read `node_modules/next/dist/docs/` before route work;
  route files export only handlers).
- Graph API version from `getMetaGraphVersion()`; all calls through `MetaGraphClient`.
  Exact endpoint fields must be verified against the Graph API reference for that version;
  the edges named below are the intended ones, not guaranteed field lists.

## What gets built

### 1. Catalogue data layer (`src/lib/meta/catalog/`)

A pure `fetchCatalogSnapshot(graph, catalogId, opts)` (graph injected, like
`fetchMetaAuditSnapshot`) that returns one typed snapshot, with each part loaded through the
existing `settle()` pattern so a failed part becomes a warning, not a crash:

| Part | Graph edge (intended) | Used for |
|---|---|---|
| Catalogue basics | `/{catalog}` name, vertical, product_count | header |
| Diagnostics | `/{catalog}/diagnostics` | Meta's own issue list, severity, affected count |
| Products | `/{catalog}/products` review_status, availability, visibility, url, image_url, price, retailer_id, errors | counts by status, rejection reasons, out of stock |
| Feeds | `/{catalog}/product_feeds` + `/{feed}/uploads` (+ upload errors) | last successful upload, error/warning counts, staleness |
| Product sets | `/{catalog}/product_sets` name, filter, product_count | size of each set, approved and in-stock share |
| Pixel / event matching | `/{catalog}/event_stats`, `/{catalog}/external_event_sources` | content_ids match rate, connected pixel |

**Live check (2026-11-04, after reconnect).** The token has `catalog_management`; business
`owned_product_catalogs` / `client_product_catalogs`, `diagnostics`, `product_sets` (with
`filter` and `product_count`), `product_feeds`, `products` (with `errors`), `event_stats`
(matched / unmatched / matched-other-catalogue content ids per event) and
`external_event_sources` all return data. Catalogues are large (During Days Catalogue-2026:
287,361 products, 55,311 out of stock per diagnostics), so **counts come from `diagnostics`,
product-set `product_count` and filtered product queries, never from reading every product**;
the Products tab pages on demand. `total_content_ids_matched_other_catalogs` is a real signal
(pixel events matching a different catalogue) and gets its own finding. Shopify-synced
catalogues often have no `product_feeds`, so "no feed" is not an error by itself.

Product reads are paged and capped (like `MAX_PRODUCT_PAGES` in the audit); a cut-off is said
so in warnings. Per product set, the "approved and in stock" count comes from reading the
set's own products (`/{product_set}/products`), capped.

**Finding a client's catalogues.** Union of:
- catalogues behind the client's catalogue ad sets: `promoted_object.product_set_id` →
  `/{product_set}?fields=product_catalog`. (Today `promotedConversion()` and the audit mapping
  drop `product_set_id` / `product_catalog_id`; both are kept from now on.)
- catalogues the client's ad accounts are connected to, where Meta exposes it.

Nothing else: the catalogues of the business that owns the ad accounts are **not** added,
because an agency portfolio would then leak every other client's catalogue into this one
(my call). A client without catalogue ads yet shows "no catalogue linked to this client".

A short in-memory cache (about 5 minutes, keyed by catalogue + user) like the dashboard route.

### 2. Findings engine (`src/lib/meta/catalog/findings.ts`)

Deterministic checks over the snapshot, in the same shape as the audit checkpoints: each has
an id, severity, the numbers that triggered it, the affected ad sets/product sets, and a
suggested fix (with an executable fix where one exists). Initial set:

- Rejected / disapproved products, grouped by reason, with spend at stake where the
  `product_id` breakdown shows spend on them.
- Out-of-stock products still in a product set that an active ad set uses.
- Feed not updated within its schedule, or last uploads with errors.
- Product set too small to deliver (few approved in-stock items) behind an ad set.
- Low pixel match rate for catalogue events (content_ids not matching catalogue items).
- Meta diagnostics passed through with their own wording.

**Learning-limited link.** For every learning-limited (FAIL) ad set that promotes a product
set, the engine reports the set's size, approved and in-stock share, feed freshness and match
rate, and concludes either "catalogue is a likely contributor because …" or "catalogue looks
healthy; the cause is elsewhere".

The LLM writes the explanation and prioritisation around these findings; it does not invent
findings the data does not show.

### 3. Chat and audit

- **Read tools** in `src/lib/tools/diagnose/catalog-tools.ts`, registered as `diagnose` in
  `TOOL_POLICY`, offered only when the client has a catalogue (same conditional pattern as the
  Shopify tools): list catalogues, catalogue health (snapshot + findings), products filtered by
  issue, feed uploads and errors, product sets with the ad sets using them. The chat can call
  them freely to answer questions.
- **Audit**: when the account has catalogue ad sets, the audit fetches the snapshot(s) and adds
  a "Catalogue (Commerce Manager) — live Meta data, authoritative" evidence section after the
  existing sections, and `META_AUDIT_FRAMEWORK` gets a catalogue lens and a report heading.
  Learning-limited findings cite the catalogue link above. Missing permission becomes an audit
  warning ("catalogue not read: reconnect Facebook to grant catalogue access").

### 4. Commerce page (`/commerce`)

New `MAIN_NAV` entry "Commerce". Uses the header's selected client (`useApp()`); a catalogue
picker lists that client's catalogues. Sections:

- **Overview**: health cards (products approved / rejected / out of stock, feed status, match
  rate), then **Suggestions**: the findings, most severe first, each with its evidence and a
  "Queue fix" button when an executable fix exists, or "How to fix" text when it does not.
- **Products**: searchable list with status, availability and issue; filter by issue.
- **Feeds**: each feed's schedule, upload history, error and warning counts, top errors.
- **Product sets**: size, approved in-stock count, the ad sets using it and their learning status.
- **Pixel matching**: connected pixel and match rate per event.
- An "Ask in Workspace" link that opens the chat with this catalogue as context.

States: not connected / missing `catalog_management` (reconnect button), no catalogue for this
client, loading, partial data (warnings shown).

### 5. Fixes through approvals

New execute tools, each with a zod schema, `TOOL_POLICY: execute`, a `dispatchToProvider` case,
provider methods (live + mock), proof in `buildExecutionResult`, and display labels:

- `update_product_set_filter`: rewrite an existing set's filter, to narrow it (exclude
  out-of-stock or rejected items) or widen it (include more items). One POST to
  `/{product_set}`. No "merge": creating a combined set and moving ad sets onto it is out of
  v1, because a live ad set's product set usually cannot be changed (my call).
- `request_feed_refresh`: one-off re-fetch of a scheduled feed.
- `update_catalog_item_availability_or_visibility`: only for catalogues not synced from a
  source that would overwrite it (the builder decides how to detect that; when unsure, do not
  offer the fix).
- Pausing catalogue ad sets/ads uses the existing `pause_*` tools.

**Blast radius (my call).** A product-set filter change or a feed refresh affects every ad set
that uses the set or catalogue, possibly in other ad accounts. These fixes are always risk
"high" (so an admin approves), and the approval shows every ad set the app can find using the
set across the client's mapped accounts, plus the note that ad sets outside those accounts
cannot be listed and would also change.

**Whose token executes (my call).** The approver's token, as for every other approval. At
approve time the executor checks that token has `catalog_management` and can read the
catalogue; if not, the approval fails with "the approver's Facebook connection cannot manage
this catalogue: reconnect, or have someone with access approve", and nothing is sent.

Queued from the Commerce page's "Queue fix" and from the chat (the optimization pipeline's
proposal path). Before/after read-back where the API allows, like the existing ad set edits.

## Decided

- Live reads with a short cache, no new database tables (my call; revisit if pages are slow).
- Findings are deterministic; the LLM explains and prioritises.
- Every write goes through approvals; source-synced product data is never edited.
- Catalogues are scoped to the client strictly through its ad sets and ad accounts.
- Catalogue-level fixes are high risk and list the ad sets they affect.
- Approver's token executes; scope and access are checked at approve time.

## Left to the builder

- Exact Graph fields per edge for the configured API version, paging sizes and caps.
- Page layout details within the sections above (follow the existing app style).
- Whether the Commerce page is one route with tabs or nested routes.
- Thresholds for "too small", "stale" and "low match rate" (document the values chosen).
- Demo-mode data for the Commerce page and tools (follow the existing demo store pattern).

## Verification

- Unit tests with a fake graph (pattern: `tests/account-dashboard.test.ts`,
  `tests/audit-changes.test.ts`) for the snapshot, catalogue discovery and every finding.
- Execute tools follow `tests/adset-edit-tools.test.ts`.
- A live read-only check against the connected account's real catalogues (Traffic Radius PTY
  LTD / During Days) once the operator has reconnected with `catalog_management`.
