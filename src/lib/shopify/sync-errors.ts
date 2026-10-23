import { AppError } from "@/lib/errors";

/** An upstream (Shopify-side) sync failure. The message is fixed text, safe to show; 502. */
export class ShopifyUpstreamError extends AppError {
  constructor(message: string) {
    super("PROVIDER_UNAVAILABLE", message, 502);
  }
}
