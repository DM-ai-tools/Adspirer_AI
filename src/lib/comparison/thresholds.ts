/** Limits the comparison report uses to decide what is a real change and what is too little data. */
export const COMPARISON_THRESHOLDS = {
  /** A change of this many percent or less is "Stable". */
  materialityPct: 5,
  /** Fewer results/purchases/leads than this in either window means too little to judge. */
  minResults: 30,
  /** Fewer impressions than this in either window means rate metrics are too noisy. */
  minImpressions: 1000,
  /** A row (campaign, ad set, ad) under this share of account spend is not worth its own finding. */
  minSpendShare: 0.05,
} as const;
