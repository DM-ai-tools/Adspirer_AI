import { z } from "zod";

export const Severity = z.enum(["high", "medium", "low"]);
export const Impact = z.enum(["high", "medium", "low"]);

export const KpiSchema = z.object({
  label: z.string(),
  value: z.string(),
  note: z.string().optional(),
  flag: z.boolean().default(false),
});

export const BulletSchema = z.object({
  lead: z.string(),
  body: z.string(),
  severity: Severity.optional(),
});

export const CampaignSchema = z.object({
  name: z.string(),
  id: z.string(),
  status: z.enum(["ACTIVE", "PAUSED", "ARCHIVED"]),
  objective: z.string(),
  buyingType: z.string().optional(),
  startDate: z.string().optional(),
  daysLive: z.number().optional(),
  spend: z.string().optional(),
  spendSharePct: z.number().nullable(),
  /** Extra performance rows shown in the campaign card (CTR, CPC, …). */
  metrics: z
    .array(z.object({ label: z.string(), value: z.string() }))
    .default([]),
  deliverySignals: z.array(BulletSchema).default([]),
  risks: z.array(BulletSchema).default([]),
  checkedAgainst: z.array(z.string()).default([]),
});

export const RiskSchema = z.object({
  title: z.string(),
  severity: Severity,
  detail: z.string(),
});

export const RecommendationSchema = z.object({
  title: z.string(),
  detail: z.string(),
  impact: Impact,
  effort: z.string().optional(),
  tags: z.array(z.string()).default([]),
});

export const AuditReportSchema = z.object({
  meta: z.object({
    reportType: z.string(),
    subtitle: z.string(),
    accountName: z.string(),
    accountId: z.string(),
    platform: z.enum(["meta", "google", "tiktok", "linkedin"]).default("meta"),
    period: z.string(),
    generatedAt: z.string(),
    currency: z.string(),
    timezone: z.string(),
  }),
  healthScore: z.number().min(0).max(100).nullable(),
  healthLabel: z.string(),
  bottomLine: z.string(),
  kpis: z.array(KpiSchema).min(1).max(4),
  snapshot: z.array(
    z.object({
      label: z.string(),
      value: z.string(),
      mono: z.boolean().default(false),
    }),
  ),
  dataNotes: z.array(z.string()).default([]),
  campaigns: z.array(CampaignSchema).default([]),
  risks: z.array(RiskSchema).default([]),
  recommendations: z.array(RecommendationSchema).default([]),
  methodology: z.string(),
});

export type AuditReport = z.infer<typeof AuditReportSchema>;
export type AuditKpi = z.infer<typeof KpiSchema>;
export type AuditCampaign = z.infer<typeof CampaignSchema>;

/** Ensure exactly 4 KPI cards for the strip layout. */
export function padKpis(
  kpis: AuditReport["kpis"],
): [
  AuditReport["kpis"][number],
  AuditReport["kpis"][number],
  AuditReport["kpis"][number],
  AuditReport["kpis"][number],
] {
  const filled = [...kpis];
  while (filled.length < 4) {
    filled.push({
      label: "Metric",
      value: "No data",
      note: "Not provided",
      flag: true,
    });
  }
  return filled.slice(0, 4) as [
    AuditReport["kpis"][number],
    AuditReport["kpis"][number],
    AuditReport["kpis"][number],
    AuditReport["kpis"][number],
  ];
}

export function parseAuditReport(input: unknown): AuditReport {
  const parsed = AuditReportSchema.parse(input);
  return {
    ...parsed,
    kpis: padKpis(parsed.kpis),
  };
}

export function tryParseAuditReport(input: unknown): AuditReport | null {
  try {
    return parseAuditReport(input);
  } catch {
    return null;
  }
}
