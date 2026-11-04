import type { MetaAdsProvider } from "@/lib/adspirer/provider";
import { ApprovalValidationError } from "@/lib/errors";
import { CATALOG_PERMISSION_MESSAGE, CatalogAccessError } from "@/lib/meta/catalog/errors";
import { getClientCommerce, type CommerceState } from "@/lib/meta/catalog/service";

export const NOT_LINKED_MESSAGE = "This product set / feed is not linked to this client's ad accounts. Nothing was changed.";

/** Feeds are found by listing each catalogue's feeds: never more than this many catalogues. */
const MAX_FEED_CATALOGS = 3;

export type CatalogTarget = { product_set_id: string } | { feed_id: string };

/**
 * Refuses a catalogue fix whose product set or feed is not one of this client's, before anything is
 * written. A product set is the client's when one of its ad sets sells it, or its catalogue is one of
 * the client's catalogues; a feed when its catalogue is. Everything here is a read.
 */
export async function assertCatalogTargetOwned(input: {
  clientId: string;
  target: CatalogTarget;
  provider: Pick<MetaAdsProvider, "productSetCatalogId" | "feedCatalogId">;
  /** Injected for tests; defaults to the client's cached catalogue discovery. */
  loadCommerce?: (clientId: string) => Promise<CommerceState>;
}): Promise<void> {
  const commerce = await (input.loadCommerce ?? getClientCommerce)(input.clientId);
  if (commerce.state === "missing_permission") throw new CatalogAccessError("missing_permission", CATALOG_PERMISSION_MESSAGE);
  if (commerce.state === "no_catalog") throw new ApprovalValidationError(NOT_LINKED_MESSAGE);
  if (commerce.state !== "ok") throw new ApprovalValidationError(`${commerce.message} Nothing was changed.`);

  const catalogIds = commerce.catalogs.map((c) => c.id);
  if ("product_set_id" in input.target) {
    const id = input.target.product_set_id;
    if (commerce.uses.some((u) => u.productSetId === id)) return;
    const catalogId = input.provider.productSetCatalogId ? await input.provider.productSetCatalogId(id) : null;
    if (catalogId && catalogIds.includes(catalogId)) return;
    throw new ApprovalValidationError(NOT_LINKED_MESSAGE);
  }

  // Catalogues that ad sets actually sell from are checked first.
  const used = [...new Set(commerce.uses.map((u) => u.catalogId))].filter((id) => catalogIds.includes(id));
  const ordered = [...used, ...catalogIds.filter((id) => !used.includes(id))].slice(0, MAX_FEED_CATALOGS);
  const owner = input.provider.feedCatalogId ? await input.provider.feedCatalogId(input.target.feed_id, ordered) : null;
  if (owner && ordered.includes(owner)) return;
  throw new ApprovalValidationError(NOT_LINKED_MESSAGE);
}
