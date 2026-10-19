import { z } from "zod";
import { goalsProfileSchema } from "@/lib/clients/goals";

/** Body accepted by PATCH /api/clients/[id]. The goals profile is replaced whole. */
export const clientPatchSchema = z.object({
  name: z.string().min(1).optional(),
  slug: z.string().min(1).optional(),
  website_url: z.string().url().nullable().optional(),
  industry: z.string().nullable().optional(),
  brand_voice: z.string().nullable().optional(),
  brand_colors: z.array(z.string()).nullable().optional(),
  brand_guidelines: z.string().nullable().optional(),
  target_audience: z.string().nullable().optional(),
  value_proposition: z.string().nullable().optional(),
  budget_ceiling_cents: z.number().int().nonnegative().nullable().optional(),
  currency: z.string().min(1).optional(),
  notes: z.string().nullable().optional(),
  business_description: z.string().max(4000).nullable().optional(),
  standing_instructions: z.string().max(4000).nullable().optional(),
  goals_profile: goalsProfileSchema.optional(),
});
