import type { Client, ClientService, CompetitorBrief } from "@/types";
import type {
  AdCreativeInsight,
  FirmographicProfile,
  TrafficSnapshot,
} from "./providers/types";
import { nowIso } from "@/lib/utils";

export type BriefResearchInput = {
  client: Client;
  service: ClientService;
  competitors: Array<{
    name: string;
    domain: string | null;
    firmographic: FirmographicProfile | null;
    traffic: TrafficSnapshot | null;
    ads: AdCreativeInsight[];
  }>;
};

export function generateCompetitorBrief(
  input: BriefResearchInput,
): Omit<
  CompetitorBrief,
  "id" | "created_at" | "updated_at" | "client_id" | "client_service_id"
> {
  const themes = new Set<string>();
  const creativePatterns: string[] = [];
  const opportunities: string[] = [];

  for (const competitor of input.competitors) {
    for (const ad of competitor.ads) {
      for (const theme of ad.themes) themes.add(theme);
      if (ad.media_type) {
        creativePatterns.push(
          `${competitor.name}: ${ad.media_type}${ad.cta ? ` · CTA ${ad.cta}` : ""}`,
        );
      }
    }
    if (competitor.ads.some((a) => a.themes.includes("urgency"))) {
      opportunities.push(
        `Match ${competitor.name} urgency CTAs for ${input.service.name} while keeping brand voice: ${input.client.brand_voice ?? "on-brand"}.`,
      );
    }
    if (competitor.ads.some((a) => a.themes.includes("financing"))) {
      opportunities.push(
        `Test financing mention in ${input.service.name} primary text.`,
      );
    }
  }

  const messagingThemes = Array.from(themes);
  const strengths = [
    input.client.value_proposition ?? "Clear value proposition",
    input.client.brand_voice
      ? `Distinctive voice (${input.client.brand_voice})`
      : "Consistent brand presence",
  ];
  const weaknesses = [
    messagingThemes.includes("urgency")
      ? "Fewer urgency CTAs than local competitors"
      : "Limited competitive contrast in recent creatives",
  ];

  if (!input.competitors.length || opportunities.length === 0) {
    opportunities.push(
      `Lead with a concrete ${input.service.name} benefit vs generic “book now” claims.`,
      `Use brand voice (${input.client.brand_voice ?? "clear and trustworthy"}) as a contrast to commodity creative.`,
      `Test proof (timeline, process, or outcome) in the first line of primary text.`,
    );
  }

  const summary = [
    `Competitive brief for ${input.client.name} · service: ${input.service.name}.`,
    `Analyzed ${input.competitors.length} competitor(s).`,
    messagingThemes.length
      ? `Dominant themes: ${messagingThemes.slice(0, 5).join(", ")}.`
      : "Limited ad intelligence available — brief uses brand + service heuristics.",
    input.competitors.some((c) => "ad_count" in c && typeof (c as { ad_count?: number }).ad_count === "number")
      ? `Meta Ad Library counts: ${input.competitors
          .map((c) => {
            const count = (c as { ad_count?: number }).ad_count;
            return count != null ? `${c.name} (${count} ads)` : c.name;
          })
          .join(", ")}.`
      : null,
    input.client.is_demo ? "DEMO DATA." : null,
  ]
    .filter(Boolean)
    .join(" ");

  return {
    status: "ready",
    summary,
    strengths,
    weaknesses,
    messaging_themes: messagingThemes,
    creative_patterns: creativePatterns.slice(0, 10),
    opportunities: Array.from(new Set(opportunities)).slice(0, 8),
    raw_research: {
      competitors: input.competitors.map((c) => ({
        name: c.name,
        domain: c.domain,
        firmographic: c.firmographic,
        traffic: c.traffic,
        ad_count: c.ads.length,
      })),
      generated_by: "brief-generator",
    },
    generated_at: nowIso(),
  };
}
