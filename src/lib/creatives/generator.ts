/**
 * Shape of an ad concept. Concepts are authored per business by
 * `writeCreativeConcepts` (concept-writer.ts); nothing here is hardcoded.
 */
export type CreativeConcept = {
  id: string;
  client_id: string;
  service_id: string | null;
  concept: string;
  hook: string;
  primary_text: string;
  headline: string;
  description: string;
  cta: string;
  creative_direction: string;
  audience: string;
  competitor_gap_addressed: string;
  reasoning: string;
  created_at: string;
};
