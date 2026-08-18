import { nanoid } from "nanoid";
import type { CompetitorBrief } from "@/types";
import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { createCompetitorProviders } from "./providers/index";
import { fetchMetaCompetitorIntel } from "./providers/sociavault";
import { generateCompetitorBrief } from "./brief-generator";
import { nowIso } from "@/lib/utils";
import { logger } from "@/lib/observability/logger";

export type MetaCompetitorIntel = {
  competitor_id: string;
  competitor_name: string;
  page_id: string | null;
  page_name: string | null;
  category: string | null;
  logo_url: string | null;
  page_likes: number | null;
  ig_username: string | null;
  ad_count: number;
  ads: Array<{
    ad_archive_id: string;
    headline: string | null;
    body: string | null;
    cta: string | null;
    image_url: string | null;
    video_url: string | null;
    landing_url: string | null;
    is_active: boolean;
    media_type: string | null;
    publisher_platform: string[] | null;
    start_date: string | null;
    end_date: string | null;
  }>;
  source: "sociavault" | "mock" | "unavailable";
};

/**
 * Research competitors for a client service and persist a structured brief.
 */
export async function researchClientService(input: {
  clientId: string;
  serviceId: string;
}): Promise<CompetitorBrief & { meta_intel?: MetaCompetitorIntel[] }> {
  const config = getConfig();
  const providers = createCompetitorProviders();

  const { client, service, competitors } = await loadResearchScope(input);

  const scope =
    competitors.length > 0
      ? competitors
      : [
          {
            id: `comp_auto_${input.clientId}`,
            client_id: input.clientId,
            name: `${service.name} category peers`,
            website_url: null,
            domain: null,
            notes: "Auto scope — keyword search via Meta Ad Library",
            created_at: nowIso(),
            updated_at: nowIso(),
          },
        ];

  const metaIntel: MetaCompetitorIntel[] = [];
  const researched = [];

  for (const competitor of scope) {
    const domain =
      "domain" in competitor && competitor.domain
        ? String(competitor.domain)
        : null;
    const firmographic = domain
      ? await providers.firmographic.lookup(domain)
      : null;
    const traffic = domain ? await providers.traffic.getTraffic(domain) : null;

    let ads = await providers.ads.searchAds({
      domain: domain ?? undefined,
      brandName: competitor.name,
      keywords: service.keywords ?? [service.name],
      limit: 12,
    });

    let intel: MetaCompetitorIntel | null = null;
    if (config.hasSociaVault) {
      try {
        const live = await fetchMetaCompetitorIntel({
          name: competitor.name,
          keywords: service.keywords ?? [service.name],
          adLimit: 12,
        });
        intel = {
          competitor_id: competitor.id,
          competitor_name: live.company?.name ?? competitor.name,
          page_id: live.company?.page_id ?? null,
          page_name: live.company?.name ?? competitor.name,
          category: live.company?.category ?? null,
          logo_url: live.company?.image_uri ?? null,
          page_likes: live.company?.likes ?? null,
          ig_username: live.company?.ig_username ?? null,
          ad_count: live.totalAdCount,
          ads: live.ads.map((a) => ({
            ad_archive_id: a.ad_archive_id,
            headline: a.headline,
            body: a.body,
            cta: a.cta,
            image_url: a.image_url,
            video_url: a.video_url,
            landing_url: a.landing_url,
            is_active: a.is_active,
            media_type: a.media_type,
            publisher_platform: a.publisher_platform,
            start_date: a.start_date,
            end_date: a.end_date,
          })),
          source: "sociavault",
        };
        metaIntel.push(intel);

        if (live.ads.length) {
          ads = live.ads.map((a) => ({
            platform: "meta",
            ad_library_id: a.ad_archive_id,
            headline: a.headline,
            body: a.body,
            cta: a.cta,
            media_type: a.media_type,
            landing_url: a.landing_url,
            first_seen_at: a.start_date,
            last_seen_at: a.end_date,
            themes: [],
            raw: a.raw,
          }));
        }
      } catch (error) {
        logger.warn("SociaVault competitor fetch failed", {
          competitor: competitor.name,
          error: error instanceof Error ? error.message : String(error),
        });
        metaIntel.push({
          competitor_id: competitor.id,
          competitor_name: competitor.name,
          page_id: null,
          page_name: competitor.name,
          category: null,
          logo_url: null,
          page_likes: null,
          ig_username: null,
          ad_count: ads.length,
          ads: [],
          source: "unavailable",
        });
      }
    }

    researched.push({
      name: competitor.name,
      domain,
      firmographic,
      traffic,
      ads,
      meta_page_id: intel?.page_id ?? null,
      ad_count: intel?.ad_count ?? ads.length,
    });
  }

  const generated = generateCompetitorBrief({
    client,
    service,
    competitors: researched,
  });

  const ts = nowIso();
  const brief: CompetitorBrief & { meta_intel?: MetaCompetitorIntel[] } = {
    id: `brief_${nanoid(10)}`,
    client_id: input.clientId,
    client_service_id: input.serviceId,
    ...generated,
    raw_research: {
      ...(generated.raw_research ?? {}),
      meta_intel: metaIntel,
      provider: config.hasSociaVault ? "sociavault" : "mock",
    },
    created_at: ts,
    updated_at: ts,
    meta_intel: metaIntel,
  };

  if (config.isDemoMode || !config.hasSupabase) {
    getDemoStore().competitorBriefs.push(brief);
  } else {
    const { meta_intel: _meta, ...briefRow } = brief;
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("competitor_briefs")
      .insert(briefRow)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    logger.info("Persisted competitor brief", {
      briefId: (data as CompetitorBrief).id,
      clientId: input.clientId,
    });
    return { ...(data as CompetitorBrief), meta_intel: metaIntel };
  }

  logger.info("Generated competitor brief", {
    briefId: brief.id,
    clientId: input.clientId,
    serviceId: input.serviceId,
    provider: config.hasSociaVault ? "sociavault" : "mock",
  });

  return brief;
}

export async function fetchClientMetaCompetitorAds(input: {
  clientId: string;
  serviceId?: string;
}): Promise<MetaCompetitorIntel[]> {
  const config = getConfig();
  if (!config.hasSociaVault) {
    throw new Error("SOCIAVAULT_API_KEY is not configured");
  }

  const { service, competitors } = await loadResearchScope({
    clientId: input.clientId,
    serviceId: input.serviceId ?? "",
  });

  const scope =
    competitors.length > 0
      ? competitors
      : [
          {
            id: `comp_auto_${input.clientId}`,
            client_id: input.clientId,
            name: service?.name ?? "Category peers",
            website_url: null,
            domain: null,
            notes: null,
            created_at: nowIso(),
            updated_at: nowIso(),
          },
        ];

  const results: MetaCompetitorIntel[] = [];
  for (const competitor of scope) {
    const live = await fetchMetaCompetitorIntel({
      name: competitor.name,
      keywords: service?.keywords ?? undefined,
      adLimit: 12,
    });
    results.push({
      competitor_id: competitor.id,
      competitor_name: live.company?.name ?? competitor.name,
      page_id: live.company?.page_id ?? null,
      page_name: live.company?.name ?? competitor.name,
      category: live.company?.category ?? null,
      logo_url: live.company?.image_uri ?? null,
      page_likes: live.company?.likes ?? null,
      ig_username: live.company?.ig_username ?? null,
      ad_count: live.totalAdCount,
      ads: live.ads.map((a) => ({
        ad_archive_id: a.ad_archive_id,
        headline: a.headline,
        body: a.body,
        cta: a.cta,
        image_url: a.image_url,
        video_url: a.video_url,
        landing_url: a.landing_url,
        is_active: a.is_active,
        media_type: a.media_type,
        publisher_platform: a.publisher_platform,
        start_date: a.start_date,
        end_date: a.end_date,
      })),
      source: "sociavault",
    });
  }
  return results;
}

async function loadResearchScope(input: {
  clientId: string;
  serviceId: string;
}) {
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    const store = getDemoStore();
    const client = store.clients.find((c) => c.id === input.clientId);
    const service =
      store.clientServices.find((s) => s.id === input.serviceId) ??
      store.clientServices.find((s) => s.client_id === input.clientId);
    if (!client || !service) {
      throw new Error("Client or service not found for competitor research");
    }
    const competitors = store.competitors.filter(
      (c) => c.client_id === input.clientId,
    );
    return { client, service, competitors };
  }

  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();
  const [{ data: client }, { data: service }, { data: competitors }] =
    await Promise.all([
      supabase.from("clients").select("*").eq("id", input.clientId).single(),
      input.serviceId
        ? supabase
            .from("client_services")
            .select("*")
            .eq("id", input.serviceId)
            .single()
        : Promise.resolve({ data: null }),
      supabase.from("competitors").select("*").eq("client_id", input.clientId),
    ]);

  if (!client) {
    throw new Error("Client not found for competitor research");
  }

  let resolvedService = service;
  if (!resolvedService && input.serviceId) {
    throw new Error("Service not found for competitor research");
  }
  if (!resolvedService) {
    const { data: services } = await supabase
      .from("client_services")
      .select("*")
      .eq("client_id", input.clientId)
      .limit(1);
    resolvedService = services?.[0] ?? null;
  }
  if (!resolvedService) {
    throw new Error("No services found for this client");
  }

  return {
    client,
    service: resolvedService,
    competitors: (competitors ?? []).map((c) => ({
      id: c.id,
      client_id: c.client_id,
      name: c.name,
      website_url: c.website ?? null,
      domain: c.website
        ? String(c.website).replace(/^https?:\/\//, "").split("/")[0]
        : null,
      notes: c.notes ?? null,
      created_at: c.created_at,
      updated_at: c.updated_at,
    })),
  };
}
