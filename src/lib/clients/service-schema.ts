import { z } from "zod";

export const serviceCreateSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().nullable().optional(),
  keywords: z.array(z.string()).nullable().optional(),
  landing_page_url: z.string().url().nullable().optional(),
  /** @deprecated alias — prefer landing_page_url */
  landing_url: z.string().url().nullable().optional(),
  priority: z.number().int().optional(),
  is_active: z.boolean().optional(),
  gross_margin_pct: z.number().min(0).max(100).nullable().optional(),
  average_order_value_cents: z.number().int().min(0).nullable().optional(),
  url_patterns: z.array(z.string().max(200)).max(20).nullable().optional(),
  source: z.enum(["manual", "import", "site_scan"]).nullable().optional(),
});

export const servicePatchSchema = serviceCreateSchema.partial().strict();
