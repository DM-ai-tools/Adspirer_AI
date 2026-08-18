export interface FirmographicProfile {
  domain: string;
  company_name: string;
  industry: string | null;
  employee_range: string | null;
  hq_location: string | null;
  description: string | null;
  raw?: Record<string, unknown>;
}

export interface TrafficSnapshot {
  domain: string;
  monthly_visits: number | null;
  bounce_rate: number | null;
  pages_per_visit: number | null;
  top_countries: string[];
  traffic_sources: Record<string, number>;
  raw?: Record<string, unknown>;
}

export interface AdCreativeInsight {
  platform: string;
  ad_library_id: string | null;
  headline: string | null;
  body: string | null;
  cta: string | null;
  media_type: string | null;
  landing_url: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  themes: string[];
  raw?: Record<string, unknown>;
}

export interface FirmographicProvider {
  readonly name: string;
  lookup(domain: string): Promise<FirmographicProfile | null>;
}

export interface TrafficIntelligenceProvider {
  readonly name: string;
  getTraffic(domain: string): Promise<TrafficSnapshot | null>;
}

export interface AdIntelligenceProvider {
  readonly name: string;
  searchAds(query: {
    domain?: string;
    brandName?: string;
    keywords?: string[];
    limit?: number;
  }): Promise<AdCreativeInsight[]>;
}
