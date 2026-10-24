import type { ShopifySalesRow } from "./types";

/** Demo-mode Shopify data for ClickTrends (live-lookup catalogue and synced sales). No network call is ever made for it. */
export const MOCK_SHOP = {
  domain: "clicktrends-demo.myshopify.com",
  name: "ClickTrends",
  currency: "USD",
} as const;

const P = (n: number) => `gid://shopify/Product/${n}`;
const V = (n: number) => `gid://shopify/ProductVariant/${n}`;
const C = (n: number) => `gid://shopify/Collection/${n}`;

type VariantSeed = {
  id: number;
  product: number;
  title: string;
  sku: string | null;
  price: number;
  cost: number | null;
  stock: number | null;
  u30: number;
  u60: number;
};

const VARIANTS: VariantSeed[] = [
  { id: 1, product: 1, title: "Oak / 65cm", sku: "BS-OAK-65", price: 14900, cost: 6200, stock: 24, u30: 18, u60: 31 },
  { id: 2, product: 1, title: "Oak / 75cm", sku: "BS-OAK-75", price: 15900, cost: 6600, stock: 9, u30: 11, u60: 22 },
  { id: 3, product: 2, title: "Black", sku: "BS-IRON-BLK", price: 11900, cost: 4800, stock: 0, u30: 7, u60: 19 },
  { id: 4, product: 3, title: "Walnut", sku: "BS-WAL-01", price: 18900, cost: null, stock: 14, u30: 5, u60: 12 },
  { id: 5, product: 4, title: "Grey / 3 seater", sku: "SF-VEL-3G", price: 129900, cost: 61000, stock: 4, u30: 3, u60: 6 },
  { id: 6, product: 4, title: "Green / 3 seater", sku: "SF-VEL-3N", price: 129900, cost: 61000, stock: 2, u30: 1, u60: 4 },
  { id: 7, product: 5, title: "Default", sku: "SF-CORNER-1", price: 189900, cost: 94500, stock: null, u30: 2, u60: 3 },
  { id: 8, product: 6, title: "Default", sku: "SF-LOVE-2", price: 79900, cost: 36000, stock: 11, u30: 0, u60: 2 },
];

/** Demo catalogue the live lookups read in DEMO_MODE (the fields live.ts uses only). */
export type MockCollection = { gid: string; handle: string; title: string };
export type MockProductStatus = "ACTIVE" | "DRAFT" | "ARCHIVED" | "UNLISTED";
export type MockProduct = {
  gid: string;
  title: string;
  handle: string;
  vendor: string;
  product_type: string;
  status: MockProductStatus;
  collection_gids: string[];
};
export type MockVariant = {
  product_gid: string;
  title: string;
  sku: string | null;
  price_cents: number;
  /** null = no cost recorded (not zero). */
  cost_cents: number | null;
  /** null = untracked / sells at zero stock (unlimited), never 0. */
  inventory_quantity: number | null;
};

/** The ClickTrends demo store as the live lookups see it (fresh copies on every call). */
export function mockLiveCatalog(): { collections: MockCollection[]; products: MockProduct[]; variants: MockVariant[] } {
  const collections: MockCollection[] = [
    { gid: C(1), handle: "bar-stools", title: "Bar stools" },
    { gid: C(2), handle: "sofas", title: "Sofas" },
  ];

  const product = (
    n: number,
    title: string,
    handle: string,
    vendor: string,
    product_type: string,
    collection: number,
    status: MockProductStatus = "ACTIVE",
  ): MockProduct => ({ gid: P(n), title, handle, vendor, product_type, status, collection_gids: [C(collection)] });

  const products: MockProduct[] = [
    product(1, "Oak Counter Stool", "oak-counter-stool", "Nordic Woodworks", "Bar Stool", 1),
    product(2, "Industrial Iron Stool", "industrial-iron-stool", "Forge & Co", "Bar Stool", 1),
    product(3, "Walnut Swivel Stool", "walnut-swivel-stool", "Nordic Woodworks", "Bar Stool", 1),
    product(4, "Velvet Three Seater Sofa", "velvet-three-seater-sofa", "Loft Living", "Sofa", 2),
    product(5, "Modular Corner Sofa", "modular-corner-sofa", "Loft Living", "Sofa", 2),
    product(6, "Compact Loveseat", "compact-loveseat", "Cosy Home", "Sofa", 2),
  ];

  const variants: MockVariant[] = VARIANTS.map((v) => ({
    product_gid: P(v.product),
    title: v.title,
    sku: v.sku,
    price_cents: v.price,
    cost_cents: v.cost,
    inventory_quantity: v.stock,
  }));

  return { collections, products, variants };
}

/** Orders (last 60 days) the demo sync reports. */
export const MOCK_SALES_ORDERS = 37;

/** Demo sales for ClickTrends: sold variants as an orders-only sync would produce them. */
export function mockShopifySales(clientId: string): ShopifySalesRow[] {
  const products = new Map<number, { title: string; vendor: string; type: string }>([
    [1, { title: "Oak Counter Stool", vendor: "Nordic Woodworks", type: "Bar Stool" }],
    [2, { title: "Industrial Iron Stool", vendor: "Forge & Co", type: "Bar Stool" }],
    [3, { title: "Walnut Swivel Stool", vendor: "Nordic Woodworks", type: "Bar Stool" }],
    [4, { title: "Velvet Three Seater Sofa", vendor: "Loft Living", type: "Sofa" }],
    [5, { title: "Modular Corner Sofa", vendor: "Loft Living", type: "Sofa" }],
  ]);
  const rows: ShopifySalesRow[] = VARIANTS.filter((v) => v.product <= 5).map((v) => {
    const p = products.get(v.product)!;
    return {
      client_id: clientId,
      variant_key: V(v.id),
      variant_gid: V(v.id),
      product_gid: P(v.product),
      product_title: p.title,
      variant_title: v.title,
      sku: v.sku,
      vendor: p.vendor,
      product_type: p.type,
      units_30d: v.u30,
      revenue_30d_cents: v.u30 * v.price,
      units_60d: v.u60,
      revenue_60d_cents: v.u60 * v.price,
    };
  });
  // A variant deleted from the store after it sold: no variant id, so a synthetic key.
  rows.push({
    client_id: clientId,
    variant_key: `product:${P(9)}:BS-DISC-01`,
    variant_gid: null,
    product_gid: P(9),
    product_title: "Discontinued Pine Stool",
    // A deleted variant keeps the title snapshotted on its order lines.
    variant_title: "Pine / 65cm",
    sku: "BS-DISC-01",
    vendor: "Nordic Woodworks",
    product_type: "Bar Stool",
    units_30d: 0,
    revenue_30d_cents: 0,
    units_60d: 4,
    revenue_60d_cents: 4 * 9900,
  });
  return rows;
}
