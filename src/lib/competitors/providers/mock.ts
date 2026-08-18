import type {
  AdCreativeInsight,
  AdIntelligenceProvider,
  FirmographicProfile,
  FirmographicProvider,
  TrafficIntelligenceProvider,
  TrafficSnapshot,
} from "./types";

const FIRMOGRAPHICS: Record<string, FirmographicProfile> = {
  "smileworks.example": {
    domain: "smileworks.example",
    company_name: "SmileWorks Dental",
    industry: "Healthcare — Dental",
    employee_range: "11-50",
    hq_location: "United States",
    description: "Multi-location family and cosmetic dentistry. DEMO DATA.",
    raw: { demo: true },
  },
  "brightbite.example": {
    domain: "brightbite.example",
    company_name: "BrightBite Orthodontics",
    industry: "Healthcare — Orthodontics",
    employee_range: "11-50",
    hq_location: "United States",
    description: "Orthodontics-focused competitor. DEMO DATA.",
    raw: { demo: true },
  },
};

export class MockFirmographicProvider implements FirmographicProvider {
  readonly name = "MockFirmographicProvider";

  async lookup(domain: string): Promise<FirmographicProfile | null> {
    const normalized = domain.replace(/^www\./, "").toLowerCase();
    return (
      FIRMOGRAPHICS[normalized] ?? {
        domain: normalized,
        company_name: normalized.split(".")[0] ?? normalized,
        industry: "Unknown",
        employee_range: null,
        hq_location: null,
        description: "Mock firmographic stub. DEMO DATA.",
        raw: { demo: true },
      }
    );
  }
}

export class MockTrafficIntelligenceProvider
  implements TrafficIntelligenceProvider
{
  readonly name = "MockTrafficIntelligenceProvider";

  async getTraffic(domain: string): Promise<TrafficSnapshot | null> {
    const seed = domain.length * 137;
    return {
      domain,
      monthly_visits: 8_000 + (seed % 40_000),
      bounce_rate: 0.42 + (seed % 20) / 100,
      pages_per_visit: 2.1 + (seed % 15) / 10,
      top_countries: ["US", "CA"],
      traffic_sources: {
        organic: 0.38,
        paid: 0.27,
        direct: 0.22,
        social: 0.13,
      },
      raw: { demo: true },
    };
  }
}

export class MockAdIntelligenceProvider implements AdIntelligenceProvider {
  readonly name = "MockAdIntelligenceProvider";

  async searchAds(query: {
    domain?: string;
    brandName?: string;
    keywords?: string[];
    limit?: number;
  }): Promise<AdCreativeInsight[]> {
    const limit = query.limit ?? 5;
    const brand = query.brandName ?? query.domain ?? "Competitor";
    const base: AdCreativeInsight[] = [
      {
        platform: "meta",
        ad_library_id: `lib_${brand.slice(0, 8)}_001`,
        headline: `${brand}: Same-Week Appointments`,
        body: "New patients welcome. Book online in minutes.",
        cta: "Book Now",
        media_type: "image",
        landing_url: query.domain
          ? `https://${query.domain}/book`
          : null,
        first_seen_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        themes: ["urgency", "new-patient", "booking"],
        raw: { demo: true },
      },
      {
        platform: "meta",
        ad_library_id: `lib_${brand.slice(0, 8)}_002`,
        headline: "Flexible Financing Available",
        body: "Invest in your smile with monthly plans.",
        cta: "Learn More",
        media_type: "carousel",
        landing_url: query.domain
          ? `https://${query.domain}/financing`
          : null,
        first_seen_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        themes: ["financing", "cosmetic"],
        raw: { demo: true },
      },
      {
        platform: "meta",
        ad_library_id: `lib_${brand.slice(0, 8)}_003`,
        headline: "Meet Our Care Team",
        body: "Experienced clinicians focused on comfort.",
        cta: "Get Started",
        media_type: "video",
        landing_url: query.domain
          ? `https://${query.domain}/team`
          : null,
        first_seen_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        themes: ["trust", "team"],
        raw: { demo: true },
      },
    ];

    const keyword = query.keywords?.[0]?.toLowerCase();
    const filtered = keyword
      ? base.filter(
          (ad) =>
            ad.headline?.toLowerCase().includes(keyword) ||
            ad.body?.toLowerCase().includes(keyword) ||
            ad.themes.some((t) => t.includes(keyword)),
        )
      : base;

    return (filtered.length ? filtered : base).slice(0, limit);
  }
}

export function createMockCompetitorProviders() {
  return {
    firmographic: new MockFirmographicProvider(),
    traffic: new MockTrafficIntelligenceProvider(),
    ads: new MockAdIntelligenceProvider(),
  };
}
