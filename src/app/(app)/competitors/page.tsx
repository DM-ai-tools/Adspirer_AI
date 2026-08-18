"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { ExternalLink, Radar } from "lucide-react";
import { toast } from "sonner";
import type { ClientService, CompetitorBrief } from "@/types";
import { apiFetch, formatRelative } from "@/lib/api-client";
import { useApp } from "@/components/layout/app-provider";
import { PageHeader } from "@/components/shared/page-header";
import { LoadingState } from "@/components/shared/loading-state";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type MetaAd = {
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
};

type MetaIntel = {
  competitor_id: string;
  competitor_name: string;
  page_id: string | null;
  page_name: string | null;
  category: string | null;
  logo_url: string | null;
  page_likes: number | null;
  ig_username: string | null;
  ad_count: number;
  ads: MetaAd[];
  source: string;
};

function CompetitorsInner() {
  const searchParams = useSearchParams();
  const { clients, selectedClientId, setSelectedClientId } = useApp();
  const clientId = searchParams.get("clientId") || selectedClientId;
  const [services, setServices] = useState<ClientService[]>([]);
  const [serviceId, setServiceId] = useState<string>("");
  const [brief, setBrief] = useState<CompetitorBrief | null>(null);
  const [metaIntel, setMetaIntel] = useState<MetaIntel[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (searchParams.get("clientId")) {
      setSelectedClientId(searchParams.get("clientId")!);
    }
  }, [searchParams, setSelectedClientId]);

  useEffect(() => {
    if (!clientId) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await apiFetch<{ services: ClientService[] }>(
          `/api/clients/${clientId}/services`,
        );
        if (cancelled) return;
        setServices(data.services);
        setServiceId(data.services[0]?.id ?? "");
        setBrief(null);
        setMetaIntel([]);
      } catch {
        if (!cancelled) {
          setServices([]);
          setServiceId("");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  async function runResearch() {
    if (!clientId || !serviceId) return;
    setBusy(true);
    try {
      const data = await apiFetch<{
        brief: CompetitorBrief;
        meta_intel: MetaIntel[];
      }>("/api/competitors/research", {
        method: "POST",
        body: JSON.stringify({ clientId, serviceId }),
      });
      setBrief(data.brief);
      setMetaIntel(data.meta_intel ?? []);
      const totalAds = (data.meta_intel ?? []).reduce(
        (sum, c) => sum + (c.ad_count ?? 0),
        0,
      );
      toast.success(
        `Competitor brief ready · ${data.meta_intel?.length ?? 0} advertisers · ${totalAds} Meta ads indexed`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Research failed");
    } finally {
      setBusy(false);
    }
  }

  const totalAds = metaIntel.reduce((sum, c) => sum + (c.ad_count ?? 0), 0);

  return (
    <div>
      <PageHeader
        title="Competitor Intelligence"
        description="Live Meta Ad Library intel via SociaVault — company pages, active ads, copy, and creative previews."
        actions={
          <div className="flex gap-2">
            <Select
              value={clientId ?? undefined}
              onValueChange={setSelectedClientId}
            >
              <SelectTrigger className="w-[200px]">
                <SelectValue placeholder="Client" />
              </SelectTrigger>
              <SelectContent>
                {clients.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={serviceId || undefined}
              onValueChange={setServiceId}
              disabled={services.length === 0}
            >
              <SelectTrigger className="w-[200px]">
                <SelectValue placeholder="Service" />
              </SelectTrigger>
              <SelectContent>
                {services.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              onClick={() => void runResearch()}
              disabled={!clientId || !serviceId || busy}
            >
              {busy ? "Fetching Meta ads…" : "Run research"}
            </Button>
          </div>
        }
      />

      {!clientId ? (
        <EmptyState
          icon={Radar}
          title="Select a client"
          description="Pick a client and service to pull Meta Ad Library competitors."
        />
      ) : !brief && metaIntel.length === 0 ? (
        <EmptyState
          icon={Radar}
          title="No research yet"
          description="Run research to fetch competitor pages and active Meta ads from the Ad Library."
        />
      ) : (
        <div className="space-y-6">
          {metaIntel.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">
                {metaIntel.length} competitor{metaIntel.length === 1 ? "" : "s"}
              </Badge>
              <Badge>{totalAds} total ads indexed</Badge>
              <span className="text-xs text-muted">
                Source:{" "}
                <a
                  href="https://docs.sociavault.com/api-reference/facebook-ad-library/company-ads"
                  className="underline"
                  target="_blank"
                  rel="noreferrer"
                >
                  SociaVault Meta Ad Library
                </a>
              </span>
            </div>
          ) : null}

          {metaIntel.map((competitor) => (
            <section key={competitor.competitor_id} className="space-y-3">
              <Card>
                <CardHeader className="flex flex-row items-start gap-4 space-y-0">
                  {competitor.logo_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={competitor.logo_url}
                      alt={competitor.competitor_name}
                      className="h-14 w-14 rounded-lg border border-border object-cover"
                    />
                  ) : (
                    <div className="flex h-14 w-14 items-center justify-center rounded-lg border border-dashed border-border bg-secondary/30 text-xs text-muted">
                      Meta
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <CardTitle className="text-lg">
                        {competitor.page_name ?? competitor.competitor_name}
                      </CardTitle>
                      <Badge>{competitor.ad_count} ads</Badge>
                      {competitor.category ? (
                        <Badge variant="outline">{competitor.category}</Badge>
                      ) : null}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-3 text-xs text-muted">
                      {competitor.page_id ? (
                        <span className="font-mono">page {competitor.page_id}</span>
                      ) : null}
                      {competitor.page_likes != null ? (
                        <span>{competitor.page_likes.toLocaleString()} page likes</span>
                      ) : null}
                      {competitor.ig_username ? (
                        <span>@{competitor.ig_username}</span>
                      ) : null}
                    </div>
                  </div>
                </CardHeader>
              </Card>

              {competitor.ads.length === 0 ? (
                <p className="text-sm text-muted">
                  No active ads returned for this advertiser.
                </p>
              ) : (
                <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
                  {competitor.ads.map((ad) => (
                    <Card key={ad.ad_archive_id} className="overflow-hidden">
                      {ad.image_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={ad.image_url}
                          alt={ad.headline ?? "Ad creative"}
                          className="aspect-square w-full border-b border-border object-cover"
                        />
                      ) : (
                        <div className="flex aspect-square items-center justify-center border-b border-border bg-secondary/20 text-xs text-muted">
                          {ad.media_type === "video" ? "Video ad" : "No preview"}
                        </div>
                      )}
                      <CardContent className="space-y-2 p-4 text-sm">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge
                            variant={ad.is_active ? "default" : "secondary"}
                          >
                            {ad.is_active ? "Active" : "Inactive"}
                          </Badge>
                          {ad.media_type ? (
                            <Badge variant="outline">{ad.media_type}</Badge>
                          ) : null}
                          {ad.publisher_platform?.map((p) => (
                            <Badge key={p} variant="outline">
                              {p}
                            </Badge>
                          ))}
                        </div>
                        {ad.headline ? (
                          <p className="font-medium">{ad.headline}</p>
                        ) : null}
                        {ad.body ? (
                          <p className="line-clamp-4 text-muted">{ad.body}</p>
                        ) : null}
                        {ad.cta ? (
                          <p className="text-xs text-accent">CTA: {ad.cta}</p>
                        ) : null}
                        <p className="font-mono text-[10px] text-muted">
                          {ad.ad_archive_id}
                        </p>
                        {ad.landing_url ? (
                          <a
                            href={ad.landing_url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
                          >
                            Landing page
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        ) : null}
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </section>
          ))}

          {brief ? (
            <div className="space-y-4 border-t border-border pt-6">
              <div className="flex items-center gap-2">
                <Badge
                  variant={
                    brief.status === "ready"
                      ? "success"
                      : brief.status === "failed"
                        ? "danger"
                        : "warning"
                  }
                >
                  Brief · {brief.status}
                </Badge>
                <span className="font-mono text-xs text-muted">
                  {formatRelative(brief.generated_at ?? brief.created_at)}
                </span>
              </div>
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Summary</CardTitle>
                </CardHeader>
                <CardContent className="whitespace-pre-wrap text-sm text-muted">
                  {brief.summary ?? "—"}
                </CardContent>
              </Card>
              <div className="grid gap-4 md:grid-cols-2">
                {(
                  [
                    ["Strengths", brief.strengths],
                    ["Weaknesses", brief.weaknesses],
                    ["Messaging themes", brief.messaging_themes],
                    ["Creative patterns", brief.creative_patterns],
                    ["Opportunities", brief.opportunities],
                  ] as const
                ).map(([title, items]) => (
                  <Card key={title}>
                    <CardHeader>
                      <CardTitle className="text-base">{title}</CardTitle>
                    </CardHeader>
                    <CardContent>
                      {items && items.length > 0 ? (
                        <ul className="list-disc space-y-1 pl-4 text-sm text-muted">
                          {items.map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-sm text-muted">—</p>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

export default function CompetitorsPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <CompetitorsInner />
    </Suspense>
  );
}
